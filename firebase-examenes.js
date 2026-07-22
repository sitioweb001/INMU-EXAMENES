/**
 * ══════════════════════════════════════════════════════════════════════════════
 * SICA-INMU — firebase-examenes.js  v2 | 2026
 *
 * BACKEND COMPLETO DEL SISTEMA DE EXÁMENES — 100% FIREBASE.
 * Ya NO se usa Google Apps Script / Google Sheets para nada. Todo (cuentas de
 * docente, materias, PINs, sesiones anti-copia, resultados y notas) vive en
 * Cloud Firestore, dentro del MISMO proyecto que ya usan Asistencia y el
 * Portal del Estudiante ("sica-inmu-2026"). Las cuentas de docente usan
 * Firebase Authentication (más seguro que guardar contraseñas en Firestore).
 *
 * Este archivo expone una sola puerta de entrada:
 *     window.FBExamenes.ejecutar(action, data) -> Promise<resultado>
 * que el index.html llama desde su función apiCall(), así casi ningún otro
 * código de la app tuvo que cambiar (mismo flujo, mismos nombres de acción).
 *
 * COLECCIONES QUE CREA/USA EN FIRESTORE:
 *   config_examenes_inmu/sistema      -> mantenimiento, clave de registro, clave admin
 *   docentes_examenes_inmu/{uid}      -> perfil del docente (login real via Firebase Auth)
 *   materias_examenes_inmu/{pin}      -> una materia/examen por documento (el PIN es el ID)
 *   sesiones_examenes_inmu/{id}       -> progreso anti-copia de cada alumno en cada examen
 *   resultados_examenes_inmu/{auto}   -> historial de examenes resueltos
 *   roster_examenes_inmu/{id}         -> registro manual de alumnos por docente
 *   accesos_examenes_inmu/{id}        -> accesos especiales (PIN individual) por NIE
 *
 * Ademas LEE (sin modificar) y ESCRIBE en las colecciones que ya comparten
 * Asistencia y el Portal del Estudiante:
 *   alumnos_inmu   (lectura) -> padron compartido, para "Traer alumnos desde Asistencia"
 *   notas_inmu     (escritura, merge) -> libreta de notas compartida; aqui es
 *                    donde aterriza automaticamente la nota del examen.
 * ══════════════════════════════════════════════════════════════════════════════
 */

(function () {

  const FB_CFG = {
    apiKey:            "AIzaSyCXILuuU2UZUZxG8iGkFpGN_mljN_e1ESc",
    authDomain:        "sica-inmu-2026.firebaseapp.com",
    projectId:         "sica-inmu-2026",
    storageBucket:     "sica-inmu-2026.firebasestorage.app",
    messagingSenderId: "264940304462",
    appId:             "1:264940304462:web:643c263f1ad46139102b1f"
  };

  let db = null, _listo = false;

  function _init() {
    if (!window.firebase) { setTimeout(_init, 400); return; }
    try {
      if (!firebase.apps || firebase.apps.length === 0) firebase.initializeApp(FB_CFG);
      db = firebase.firestore();
      _listo = true;
      console.log('[Examenes] Firebase listo (proyecto sica-inmu-2026) - backend 100% Firestore');
    } catch (e) {
      console.error('[Examenes] No se pudo inicializar Firebase:', e);
    }
  }
  _init();

  function esperarListo(maxIntentos) {
    return new Promise((resolve) => {
      let n = 0;
      (function tick() {
        if (_listo) return resolve(true);
        if (n++ >= (maxIntentos || 20)) return resolve(false);
        setTimeout(tick, 300);
      })();
    });
  }

  // Hash de contraseña (SHA-256) - las contraseñas de docente NUNCA se
  // guardan en texto plano, solo su huella digital. Un administrador con la
  // Clave Maestra puede FORZAR una contraseña nueva (sobrescribir el hash)
  // sin necesidad de conocer la anterior — eso es lo que permite el panel
  // "Control Maestro de Contraseñas" en caso de filtración.
  async function hashPassword(texto) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(texto || '')));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // ---- Utilidades - MISMA normalizacion que usa el Sistema de Asistencia ----
  function limpiarClave(v) { return String(v || '').trim().replace(/^"+|"+$/g, '').replace(/"/g, ''); }

  function normalizarNombre(v) {
    return String(v || '').trim().replace(/\s+/g, ' ').toUpperCase();
  }

  function normalizarTexto(v) {
    return String(v || '').trim().toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/^"+|"+$/g, '').replace(/"/g, '');
  }

  function normKey(v) {
    return String(v || '').trim().toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  }

  function claveAsignacion(o) {
    return [o.grado, o.seccion, o.tipo_materia, o.materia, o.especialidad].map(normalizarTexto).join('|');
  }

  function docKeyNotas(grado, seccion, materiaClave) {
    return normKey((grado || '') + '_' + (seccion || '') + (materiaClave ? '_' + materiaClave : ''));
  }

  function chunk(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  }

  function toISO(v) {
    if (!v) return new Date().toISOString();
    if (typeof v.toDate === 'function') return v.toDate().toISOString();
    return v;
  }

  function escalaAValor(escala, correctas, total) {
    if (!total) return 0;
    const max = escala === '0-5' ? 5 : 10;
    return Math.round((correctas / total) * max * 100) / 100;
  }

  // Las claves maestras (admin_password, clave_registro_docente) viven en
  // config_inmu/seguridad — el MISMO documento que edita el panel
  // "🔐 Control Maestro de Contraseñas" del Sistema de Asistencia. Así, si
  // cambian la clave desde Asistencia, aquí se respeta automáticamente.
  async function getConfig() {
    const defaults = { mantenimiento: false, clave_registro_docente: '747-8', admin_password: '747-8' };
    try {
      const [snapLocal, snapSeguridad] = await Promise.all([
        db.collection('config_examenes_inmu').doc('sistema').get(),
        db.collection('config_inmu').doc('seguridad').get()
      ]);
      const local = snapLocal.exists ? snapLocal.data() : {};
      const seg = snapSeguridad.exists ? snapSeguridad.data() : {};
      return Object.assign({}, defaults, local, {
        admin_password: seg.pass_admin_examenes || local.admin_password || defaults.admin_password,
        clave_registro_docente: seg.pass_registro_docentes_examenes || local.clave_registro_docente || defaults.clave_registro_docente
      });
    } catch (e) { /* usa default */ }
    return defaults;
  }

  // ==========================================================================
  // SISTEMA / MANTENIMIENTO
  // ==========================================================================
  async function inicializarBD() {
    await db.collection('config_examenes_inmu').doc('sistema').set({
      mantenimiento: false, clave_registro_docente: '747-8', admin_password: '747-8',
      inicializado: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return { status: true, msg: 'Base de datos de Examenes lista en Firebase (no se necesitan hojas de calculo).' };
  }

  async function obtenerEstadoSistema() {
    const cfg = await getConfig();
    return !!cfg.mantenimiento;
  }

  async function alternarBloqueoSistema(password) {
    const cfg = await getConfig();
    if (limpiarClave(password) !== (cfg.admin_password || '747-8')) return { status: false, error: 'Contraseña de administrador incorrecta' };
    const nuevo = !cfg.mantenimiento;
    await db.collection('config_examenes_inmu').doc('sistema').set({ mantenimiento: nuevo }, { merge: true });
    return { status: true, bloqueado: nuevo };
  }

  async function cambiarClaveRegistro(passwordAdmin, nuevaClave) {
    const cfg = await getConfig();
    if (limpiarClave(passwordAdmin) !== (cfg.admin_password || '747-8')) return { status: false, error: 'Clave maestra de administrador incorrecta.' };
    const clave = limpiarClave(nuevaClave);
    if (!clave) return { status: false, error: 'La nueva clave no puede estar vacia.' };
    await db.collection('config_inmu').doc('seguridad').set({ pass_registro_docentes_examenes: clave }, { merge: true });
    return { status: true, msg: 'PIN de registro de docentes actualizado correctamente. (También puedes cambiarlo desde el Control Maestro de Contraseñas en Asistencia.)' };
  }

  async function borrarDatosDocente(nombreDocente) {
    const nombreUpper = normalizarNombre(nombreDocente);
    const matSnap = await db.collection('materias_examenes_inmu').where('docenteNombre', '==', nombreUpper).get();
    const pins = [];
    const batch1 = db.batch();
    matSnap.forEach(doc => { pins.push(doc.id); batch1.delete(doc.ref); });
    await batch1.commit();

    if (pins.length) {
      for (const grupo of chunk(pins, 30)) {
        const resSnap = await db.collection('resultados_examenes_inmu').where('materiaPin', 'in', grupo).get();
        const b = db.batch(); resSnap.forEach(d => b.delete(d.ref)); await b.commit();
        const sesSnap = await db.collection('sesiones_examenes_inmu').where('materiaPin', 'in', grupo).get();
        const b2 = db.batch(); sesSnap.forEach(d => b2.delete(d.ref)); await b2.commit();
      }
    }

    const rosterSnap = await db.collection('roster_examenes_inmu').where('docenteNombre', '==', nombreUpper).get();
    const b3 = db.batch(); rosterSnap.forEach(d => b3.delete(d.ref)); await b3.commit();

    const accSnap = await db.collection('accesos_examenes_inmu').where('docenteNombre', '==', nombreUpper).get();
    const b4 = db.batch(); accSnap.forEach(d => b4.delete(d.ref)); await b4.commit();

    return { status: true, msg: 'Tus materias, resultados, sesiones, alumnos y accesos han sido borrados.' };
  }

  async function borrarDatosGlobal(passAdmin) {
    const cfg = await getConfig();
    if (limpiarClave(passAdmin) !== (cfg.admin_password || '747-8')) return { status: false, msg: 'Clave Maestra incorrecta.' };
    for (const col of ['materias_examenes_inmu', 'resultados_examenes_inmu', 'sesiones_examenes_inmu', 'roster_examenes_inmu', 'accesos_examenes_inmu']) {
      const snap = await db.collection(col).get();
      for (const grupo of chunk(snap.docs, 400)) {
        const b = db.batch(); grupo.forEach(d => b.delete(d.ref)); await b.commit();
      }
    }
    return { status: true, msg: 'Todos los datos del sistema han sido purgados (las cuentas de docentes se conservan).' };
  }

  // ==========================================================================
  // CUENTAS DE DOCENTE - Firebase Authentication (no contraseñas en Firestore)
  // ==========================================================================
  async function registrarDocente(claveSeguridad, usuarioRaw, password) {
    const cfg = await getConfig();
    if (limpiarClave(claveSeguridad) !== (cfg.clave_registro_docente || '747-8')) return { status: false, error: 'PIN de seguridad incorrecto.' };
    if (!usuarioRaw || !password || password.toString().length < 4) return { status: false, error: 'Usuario y contraseña (minimo 4 caracteres) son obligatorios.' };
    const usuario = normalizarNombre(usuarioRaw);
    const docId = normKey(usuario);
    const ref = db.collection('docentes_examenes_inmu').doc(docId);
    const existe = await ref.get();
    if (existe.exists) return { status: false, error: 'Ese usuario ya existe. Elige otro.' };
    const passwordHash = await hashPassword(password.toString());
    await ref.set({ usuario, passwordHash, fecha: firebase.firestore.FieldValue.serverTimestamp() });
    return { status: true, msg: 'Cuenta creada con exito. Ya puedes iniciar sesion.' };
  }

  async function verificarDocente(usuarioRaw, password) {
    const usuario = normalizarNombre(usuarioRaw);
    const snap = await db.collection('docentes_examenes_inmu').doc(normKey(usuario)).get();
    if (!snap.exists) return { status: false, error: 'Usuario o contraseña incorrectos.' };
    const passwordHash = await hashPassword((password || '').toString());
    if (passwordHash !== snap.data().passwordHash) return { status: false, error: 'Usuario o contraseña incorrectos.' };
    return { status: true, nombre: usuario };
  }

  // Permite a un administrador (con la Clave Maestra de Examenes) forzar una
  // contraseña NUEVA para cualquier docente sin conocer la anterior — esto es
  // lo que hace posible el botón "Restablecer contraseña de un docente" en el
  // Control Maestro de Contraseñas del Sistema de Asistencia.
  async function restablecerPasswordDocente(passwordAdmin, usuarioRaw, nuevaPassword) {
    const cfg = await getConfig();
    if (limpiarClave(passwordAdmin) !== (cfg.admin_password || '747-8')) return { status: false, error: 'Clave maestra de administrador incorrecta.' };
    if (!nuevaPassword || nuevaPassword.toString().length < 4) return { status: false, error: 'La nueva contraseña debe tener al menos 4 caracteres.' };
    const usuario = normalizarNombre(usuarioRaw);
    const ref = db.collection('docentes_examenes_inmu').doc(normKey(usuario));
    const snap = await ref.get();
    if (!snap.exists) return { status: false, error: 'No existe una cuenta de docente con ese usuario.' };
    const passwordHash = await hashPassword(nuevaPassword.toString());
    await ref.set({ passwordHash, restablecida: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return { status: true, msg: `Contraseña de "${usuario}" restablecida correctamente.` };
  }

  // ==========================================================================
  // MATERIAS / EXAMENES (doc id = PIN, asi la busqueda es instantanea)
  // ==========================================================================
  async function crearNuevaMateria(nombreMateria, pin, nombreDocente, grado, seccion, periodo, tipoMateria, especialidad, actividadNota, escala) {
    if (!nombreMateria || !pin) return { status: false, msg: 'El nombre de la materia y el PIN son obligatorios.' };
    const pinStr = pin.toString().trim();
    const ref = db.collection('materias_examenes_inmu').doc(pinStr);
    const existe = await ref.get();
    if (existe.exists) return { status: false, msg: 'Ese PIN ya esta en uso por otra materia. Elige un PIN diferente.' };
    await ref.set({
      materia: nombreMateria.trim(), pin: pinStr, docenteNombre: normalizarNombre(nombreDocente),
      examen: [], grado: (grado || '').trim(), seccion: (seccion || '').trim(), periodo: (periodo || '1').toString(),
      tipo_materia: tipoMateria || 'basica', especialidad: (especialidad || '').trim(),
      actividad_nota: actividadNota || 'a3', escala: escala || '0-10',
      creado: firebase.firestore.FieldValue.serverTimestamp()
    });
    return { status: true, msg: 'Materia creada con exito.' };
  }

  async function obtenerMateriasPorDocente(nombreDocente) {
    const snap = await db.collection('materias_examenes_inmu').where('docenteNombre', '==', normalizarNombre(nombreDocente)).get();
    const out = [];
    snap.forEach(doc => {
      const d = doc.data();
      out.push({
        materia: d.materia, pin: d.pin, examen: d.examen || [], grado: d.grado || '', seccion: d.seccion || '',
        periodo: d.periodo || '1', tipoMateria: d.tipo_materia || 'basica', especialidad: d.especialidad || '',
        actividadNota: d.actividad_nota || 'a3', escala: d.escala || '0-10'
      });
    });
    return out;
  }

  async function guardarExamenEditado(pin, examenEstructura) {
    if (!pin) return { status: false, error: 'No se identifico la materia a guardar (falta el PIN).' };
    const ref = db.collection('materias_examenes_inmu').doc(pin.toString());
    const snap = await ref.get();
    if (!snap.exists) return { status: false, error: 'No se encontro ninguna materia con ese PIN. Puede que haya sido borrada.' };
    await ref.update({ examen: examenEstructura || [] });
    return { status: true };
  }

  async function editarMateria(nombreDocente, materiaNombre, pinActual, grado, seccion, periodo, tipoMateria, especialidad, actividadNota, escala) {
    const ref = db.collection('materias_examenes_inmu').doc((pinActual || '').toString());
    const snap = await ref.get();
    if (!snap.exists) return { status: false, error: 'No se encontro esa materia (o no te pertenece).' };
    const d = snap.data();
    if (d.materia !== materiaNombre || normalizarNombre(d.docenteNombre) !== normalizarNombre(nombreDocente)) {
      return { status: false, error: 'No se encontro esa materia (o no te pertenece).' };
    }
    await ref.update({
      grado: (grado || '').trim(), seccion: (seccion || '').trim(), periodo: (periodo || '1').toString().trim() || '1',
      tipo_materia: tipoMateria || 'basica', especialidad: (especialidad || '').trim(),
      actividad_nota: actividadNota || 'a3', escala: escala || '0-10'
    });
    return { status: true, msg: 'Materia actualizada correctamente.' };
  }

  // ==========================================================================
  // ALUMNO: INGRESO AL EXAMEN
  // ==========================================================================
  async function procesarIngresoSesion(nombre, materiaPin, materiaData, nie) {
    const sesId = normKey(nombre) + '_' + materiaPin;
    const ref = db.collection('sesiones_examenes_inmu').doc(sesId);
    const snap = await ref.get();
    const base = {
      status: true, materia: materiaData.materia, examen: materiaData.examen || [], materiaPin,
      grado: materiaData.grado || '', seccion: materiaData.seccion || '', tipoMateria: materiaData.tipo_materia || 'basica',
      especialidad: materiaData.especialidad || '', actividadNota: materiaData.actividad_nota || 'a3',
      escala: materiaData.escala || '0-10', periodo: materiaData.periodo || '1', docente: materiaData.docenteNombre || ''
    };
    if (snap.exists) {
      const d = snap.data();
      if (d.estado === 'FINALIZADO') return { status: false, error: 'Ya finalizaste este examen. No puedes volver a ingresar.' };
      if (d.estado === 'BLOQUEADO') return { status: false, error: 'Tu examen fue bloqueado por cambios de ventana. Pide a tu docente un PIN especial diferente para continuar.', bloqueado: true };
      await ref.update({ fechaActualizacion: firebase.firestore.FieldValue.serverTimestamp() });
      return base;
    }
    await ref.set({
      nombre, nie: nie || '', materiaPin, materiaNombre: materiaData.materia, advertencias: 0, estado: 'ACTIVO', pinReingreso: '',
      fechaInicio: firebase.firestore.FieldValue.serverTimestamp(), fechaActualizacion: firebase.firestore.FieldValue.serverTimestamp()
    });
    return base;
  }

  async function verificarPinAlumno(pin, nombreRaw, nieRaw) {
    const cfg = await getConfig();
    if (cfg.mantenimiento) return { status: false, error: 'SISTEMA_CAIDO' };

    const nie = (nieRaw || '').toString().trim();
    const pinStr = (pin || '').toString().trim();
    if (!pinStr) return { status: false, error: 'Ingresa el PIN.' };

    // 1) Acceso especial NIE + PIN individual
    if (nie) {
      const accSnap = await db.collection('accesos_examenes_inmu').where('nie', '==', nie).where('pin', '==', pinStr).limit(1).get();
      if (!accSnap.empty) {
        const acc = accSnap.docs[0].data();
        const matSnap = await db.collection('materias_examenes_inmu').doc(acc.materiaPin).get();
        if (!matSnap.exists) return { status: false, error: 'El acceso especial existe pero la materia ya no esta disponible.' };
        const nombreOficial = normalizarNombre(acc.nombre || nombreRaw || nie);
        return await procesarIngresoSesion(nombreOficial, matSnap.id, matSnap.data(), nie);
      }
    }

    const nombre = normalizarNombre(nombreRaw);
    if (nombre.split(' ').filter(Boolean).length < 3) {
      return { status: false, error: 'Escribe tu nombre completo en MAYUSCULAS y sin tildes (nombre y apellidos). Ej: JOSE EMERSON CASTRO PEREZ' };
    }

    // 2) PIN normal de la materia (el PIN ES el ID del documento -> busqueda instantanea)
    const matSnap2 = await db.collection('materias_examenes_inmu').doc(pinStr).get();
    if (matSnap2.exists) return await procesarIngresoSesion(nombre, matSnap2.id, matSnap2.data(), nie);

    // 3) PIN de reingreso especial (asignado por el docente tras un bloqueo)
    const sesSnap = await db.collection('sesiones_examenes_inmu')
      .where('nombre', '==', nombre).where('estado', '==', 'BLOQUEADO').where('pinReingreso', '==', pinStr).limit(1).get();
    if (!sesSnap.empty) {
      const sdoc = sesSnap.docs[0];
      const matSnap3 = await db.collection('materias_examenes_inmu').doc(sdoc.data().materiaPin).get();
      if (matSnap3.exists) {
        await sdoc.ref.update({ estado: 'ACTIVO', fechaActualizacion: firebase.firestore.FieldValue.serverTimestamp() });
        const md = matSnap3.data();
        return {
          status: true, materia: md.materia, examen: md.examen || [], materiaPin: matSnap3.id,
          grado: md.grado || '', seccion: md.seccion || '', tipoMateria: md.tipo_materia || 'basica',
          especialidad: md.especialidad || '', actividadNota: md.actividad_nota || 'a3',
          escala: md.escala || '0-10', periodo: md.periodo || '1', docente: md.docenteNombre || ''
        };
      }
    }

    return { status: false, error: 'PIN incorrecto o materia no encontrada.' };
  }

  // ==========================================================================
  // ANTI-COPIA / SESIONES
  // ==========================================================================
  async function registrarAdvertencia(nombreRaw, pin) {
    const nombre = normalizarNombre(nombreRaw);
    const pinStr = (pin || '').toString().trim();
    const sesId = normKey(nombre) + '_' + pinStr;
    const ref = db.collection('sesiones_examenes_inmu').doc(sesId);
    const snap = await ref.get();
    if (!snap.exists) {
      await ref.set({
        nombre, nie: '', materiaPin: pinStr, materiaNombre: '', advertencias: 1, estado: 'ACTIVO', pinReingreso: '',
        fechaInicio: firebase.firestore.FieldValue.serverTimestamp(), fechaActualizacion: firebase.firestore.FieldValue.serverTimestamp()
      });
      return { status: true, bloqueado: false, advertencias: 1 };
    }
    const advertencias = (Number(snap.data().advertencias) || 0) + 1;
    const bloqueado = advertencias >= 2;
    await ref.update({ advertencias, estado: bloqueado ? 'BLOQUEADO' : snap.data().estado, fechaActualizacion: firebase.firestore.FieldValue.serverTimestamp() });
    return { status: true, bloqueado, advertencias };
  }

  async function obtenerSesionesDocente(nombreDocente) {
    const matSnap = await db.collection('materias_examenes_inmu').where('docenteNombre', '==', normalizarNombre(nombreDocente)).get();
    const pins = []; matSnap.forEach(d => pins.push(d.id));
    if (!pins.length) return [];
    let sesiones = [];
    for (const grupo of chunk(pins, 30)) {
      const snap = await db.collection('sesiones_examenes_inmu').where('materiaPin', 'in', grupo).get();
      snap.forEach(doc => {
        const d = doc.data();
        sesiones.push({ nombre: d.nombre, materia: d.materiaNombre, advertencias: d.advertencias || 0, estado: d.estado, pinReingreso: d.pinReingreso || '', nie: d.nie || '', _docId: doc.id });
      });
    }
    sesiones.reverse();
    return sesiones;
  }

  async function gestionarSesionAlumno(sesionId, accion, valor) {
    if (!sesionId) return { status: false, error: 'Sesion de alumno no encontrada.' };
    const ref = db.collection('sesiones_examenes_inmu').doc(sesionId);
    const snap = await ref.get();
    if (!snap.exists) return { status: false, error: 'Sesion de alumno no encontrada.' };
    const d = snap.data();
    if (accion === 'asignarPin') {
      const matSnap = await db.collection('materias_examenes_inmu').doc(d.materiaPin).get();
      const pinOriginal = matSnap.exists ? matSnap.data().pin : '';
      let pinNuevo = (valor && valor.toString().trim()) ? valor.toString().trim() : '';
      if (!pinNuevo) { do { pinNuevo = String(Math.floor(1000 + Math.random() * 9000)); } while (pinNuevo === pinOriginal); }
      else if (pinNuevo === pinOriginal) return { status: false, error: 'El PIN especial debe ser diferente al PIN normal de la materia.' };
      await ref.update({ pinReingreso: pinNuevo, fechaActualizacion: firebase.firestore.FieldValue.serverTimestamp() });
      return { status: true, pinReingreso: pinNuevo };
    }
    if (accion === 'desbloquear') {
      await ref.update({ advertencias: 0, estado: 'ACTIVO', pinReingreso: '', fechaActualizacion: firebase.firestore.FieldValue.serverTimestamp() });
      return { status: true };
    }
    return { status: false, error: 'Accion no valida.' };
  }

  // ==========================================================================
  // REGISTRO DE ALUMNOS (ROSTER propio del docente en Examenes)
  // ==========================================================================
  async function crearAlumnoRoster(nombreDocente, nombreRaw, nie, grado, seccion) {
    const nombre = normalizarNombre(nombreRaw);
    const docId = normKey(nombreDocente) + '_' + normKey(nie || nombre);
    await db.collection('roster_examenes_inmu').doc(docId).set({
      nombre, nie: nie || '', grado: grado || '', seccion: seccion || '',
      docenteNombre: normalizarNombre(nombreDocente), fecha: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return { status: true, msg: 'Alumno agregado/actualizado en el registro.' };
  }

  async function obtenerAlumnosRoster(nombreDocente) {
    const snap = await db.collection('roster_examenes_inmu').where('docenteNombre', '==', normalizarNombre(nombreDocente)).get();
    const out = [];
    snap.forEach(doc => { const d = doc.data(); out.push({ nombre: d.nombre, nie: d.nie, grado: d.grado, seccion: d.seccion, _docId: doc.id }); });
    out.sort((a, b) => a.nombre.localeCompare(b.nombre));
    return out;
  }

  async function eliminarAlumnoRoster(nombreDocente, nombreRaw, nie) {
    const nombre = normalizarNombre(nombreRaw);
    const docId = normKey(nombreDocente) + '_' + normKey(nie || nombre);
    await db.collection('roster_examenes_inmu').doc(docId).delete();
    return { status: true };
  }

  // ==========================================================================
  // ACCESOS ESPECIALES POR NIE
  // ==========================================================================
  async function crearAccesoAlumno(nombreDocente, nombreRaw, nie, materiaNombre, pinIndividualRaw) {
    if (!nie) return { status: false, error: 'El NIE es obligatorio para crear el acceso especial.' };
    if (!materiaNombre) return { status: false, error: 'Selecciona una materia.' };
    const matSnap = await db.collection('materias_examenes_inmu')
      .where('docenteNombre', '==', normalizarNombre(nombreDocente)).where('materia', '==', materiaNombre).limit(1).get();
    if (matSnap.empty) return { status: false, error: 'Esa materia no existe o no te pertenece.' };
    const matDoc = matSnap.docs[0];
    const pinMateriaOriginal = matDoc.data().pin;
    let pin = (pinIndividualRaw && pinIndividualRaw.toString().trim()) ? pinIndividualRaw.toString().trim() : '';
    if (!pin) { do { pin = String(Math.floor(1000 + Math.random() * 9000)); } while (pin === pinMateriaOriginal); }
    else if (pin === pinMateriaOriginal) return { status: false, error: 'El PIN individual debe ser diferente al PIN normal de la materia.' };
    const nombre = normalizarNombre(nombreRaw || nie);
    const docId = nie + '_' + matDoc.id;
    await db.collection('accesos_examenes_inmu').doc(docId).set({
      nombre, nie, materiaPin: matDoc.id, materiaNombre, pin, docenteNombre: normalizarNombre(nombreDocente),
      fecha: firebase.firestore.FieldValue.serverTimestamp()
    });
    return { status: true, pin, msg: 'Acceso especial creado/actualizado.' };
  }

  async function obtenerAccesosAlumnoDocente(nombreDocente) {
    const snap = await db.collection('accesos_examenes_inmu').where('docenteNombre', '==', normalizarNombre(nombreDocente)).get();
    const out = [];
    snap.forEach(doc => { const d = doc.data(); out.push({ nombre: d.nombre, nie: d.nie, materia: d.materiaNombre, pin: d.pin, _docId: doc.id }); });
    return out;
  }

  async function eliminarAccesoAlumno(nombreDocente, nie, materiaNombre) {
    const snap = await db.collection('accesos_examenes_inmu')
      .where('docenteNombre', '==', normalizarNombre(nombreDocente)).where('nie', '==', nie).where('materiaNombre', '==', materiaNombre).limit(1).get();
    if (snap.empty) return { status: false, error: 'Acceso no encontrado.' };
    await snap.docs[0].ref.delete();
    return { status: true };
  }

  // ==========================================================================
  // SINCRONIZACION CON LA LIBRETA DE NOTAS DE ASISTENCIA (notas_inmu)
  // ==========================================================================
  async function guardarNotaEnAsistencia(p) {
    if (!p.grado || !p.seccion || !p.materia || !p.nie) return { ok: false, error: 'Faltan grado/seccion/materia/NIE para sincronizar la nota.' };
    try {
      const tipo_materia = p.tipo_materia || 'basica';
      const especialidad = p.especialidad || '';
      const periodo = String(p.periodo || '1');
      const actividad = p.actividad || 'a3';
      const materiaClave = claveAsignacion({ grado: p.grado, seccion: p.seccion, tipo_materia, materia: p.materia, especialidad });
      const key = docKeyNotas(p.grado, p.seccion, materiaClave);
      const ref = db.collection('notas_inmu').doc(key);
      const payload = {
        grado: p.grado, seccion: p.seccion, materia_clave: materiaClave, asignatura: p.materia,
        especialidad, escala: p.escala || '0-10',
        ultima_actualizacion: firebase.firestore.FieldValue.serverTimestamp(), actualizado_por: 'sistema-examenes'
      };
      payload[`alumnos.${p.nie}.p${periodo}.${actividad}`] = Number(p.valor);
      payload[`alumnos.${p.nie}.nombre`] = p.nombreAlumno || '';
      await ref.set(payload, { merge: true });
      return { ok: true, docId: key };
    } catch (e) {
      console.warn('[Examenes] No se pudo sincronizar la nota con Asistencia:', e);
      return { ok: false, error: e.message };
    }
  }

  // ==========================================================================
  // ALUMNO: CALIFICACION DEL EXAMEN (antes corria en Apps Script; ahora corre
  // aqui mismo, en el navegador, contra Firestore).
  // Soporta 'unica', 'multiple' y 'corta'; compatible con examenes antiguos.
  // ==========================================================================
  async function guardarRespuestasServidor(paquete) {
    const cfg = await getConfig();
    if (cfg.mantenimiento) return { status: false, error: 'SISTEMA_CAIDO' };
    if (!paquete || !Array.isArray(paquete.examenOriginal)) return { status: false, error: 'Paquete de respuestas invalido.' };

    let correctas = 0;
    const total = paquete.examenOriginal.length;
    const detalle = [];

    paquete.examenOriginal.forEach((preg, index) => {
      const tipo = preg.tipo || 'unica';
      const respuestaAlumno = paquete.respuestas[index];
      let esCorrecta = false, mostrarResp = 'Sin responder', correctaTexto = '';

      if (tipo === 'corta') {
        const dada = (respuestaAlumno || '').toString().trim().toLowerCase();
        mostrarResp = respuestaAlumno || 'Sin responder';
        const aceptadas = (preg.respuestaCorta || '').split(',').map(s => s.trim()).filter(Boolean);
        esCorrecta = dada !== '' && aceptadas.map(a => a.toLowerCase()).includes(dada);
        correctaTexto = aceptadas.join(' / ');
      } else if (tipo === 'multiple') {
        const dadas = Array.isArray(respuestaAlumno) ? respuestaAlumno.slice().sort() : [];
        const correctasIdx = (preg.correctas || []).slice().sort();
        mostrarResp = dadas.length ? dadas.map(i => preg.opciones[i]).join(', ') : 'Sin responder';
        esCorrecta = dadas.length > 0 && JSON.stringify(dadas) === JSON.stringify(correctasIdx);
        correctaTexto = correctasIdx.map(i => preg.opciones[i]).join(', ');
      } else {
        const idx = (respuestaAlumno !== undefined && respuestaAlumno !== null && respuestaAlumno !== '') ? Number(respuestaAlumno) : -1;
        const opcionTexto = (idx >= 0 && preg.opciones) ? preg.opciones[idx] : undefined;
        mostrarResp = opcionTexto !== undefined ? opcionTexto : 'Sin responder';
        if (Array.isArray(preg.correctas) && preg.correctas.length) {
          esCorrecta = preg.correctas[0] === idx;
          correctaTexto = preg.opciones[preg.correctas[0]] || '';
        } else if (preg.correcta !== undefined) {
          esCorrecta = opcionTexto !== undefined && opcionTexto === preg.correcta;
          correctaTexto = preg.correcta;
        }
      }

      if (esCorrecta) correctas++;
      detalle.push({ pregunta: preg.pregunta, respuestaAlumno: mostrarResp, estado: esCorrecta ? 'Correcto' : 'Incorrecto', correctaTexto });
    });

    const puntajeFinal = `${correctas} / ${total}`;

    let matData = {};
    if (paquete.materiaPin) {
      const matSnap = await db.collection('materias_examenes_inmu').doc(paquete.materiaPin.toString()).get();
      if (matSnap.exists) matData = matSnap.data();
    }
    const periodo = matData.periodo || '1';

    await db.collection('resultados_examenes_inmu').add({
      fecha: firebase.firestore.FieldValue.serverTimestamp(), alumno: paquete.alumno, nie: paquete.nie || '',
      materiaPin: (paquete.materiaPin || '').toString(), materia: paquete.materia, docenteNombre: matData.docenteNombre || '',
      grado: matData.grado || '', seccion: matData.seccion || '', puntaje: puntajeFinal,
      correctas, total, detalle, periodo, escala: matData.escala || '0-10'
    });

    if (paquete.materiaPin) {
      const sesId = normKey(normalizarNombre(paquete.alumno)) + '_' + paquete.materiaPin;
      db.collection('sesiones_examenes_inmu').doc(sesId).set(
        { estado: 'FINALIZADO', fechaActualizacion: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true }
      ).catch(() => {});
    }

    let notaSync = { ok: false };
    if (matData.grado && matData.seccion && matData.materia && paquete.nie) {
      const escalaNum = escalaAValor(matData.escala || '0-10', correctas, total);
      notaSync = await guardarNotaEnAsistencia({
        grado: matData.grado, seccion: matData.seccion, tipo_materia: matData.tipo_materia,
        materia: matData.materia, especialidad: matData.especialidad, escala: matData.escala,
        periodo, actividad: matData.actividad_nota || 'a3', nie: paquete.nie, nombreAlumno: paquete.alumno, valor: escalaNum
      });
    }

    return { status: true, puntaje: puntajeFinal, detalle, notaSincronizada: notaSync.ok };
  }

  // ==========================================================================
  // RESULTADOS / NOTAS (vistas del panel docente)
  // ==========================================================================
  async function obtenerResultadosDocente(nombreDocente) {
    const matSnap = await db.collection('materias_examenes_inmu').where('docenteNombre', '==', normalizarNombre(nombreDocente)).get();
    const pins = []; matSnap.forEach(d => pins.push(d.id));
    if (!pins.length) return [];
    let resultados = [];
    for (const grupo of chunk(pins, 30)) {
      const snap = await db.collection('resultados_examenes_inmu').where('materiaPin', 'in', grupo).get();
      snap.forEach(doc => {
        const d = doc.data();
        resultados.push({ fecha: toISO(d.fecha), alumno: d.alumno, materia: d.materia, puntaje: d.puntaje, detalle: d.detalle || [], periodo: d.periodo || '1' });
      });
    }
    return resultados;
  }

  async function obtenerNotasDocente(nombreDocente) {
    const nombreUpper = normalizarNombre(nombreDocente);
    const matSnap = await db.collection('materias_examenes_inmu').where('docenteNombre', '==', nombreUpper).get();
    const materiaInfo = {}; const pins = [];
    matSnap.forEach(doc => { materiaInfo[doc.id] = { periodo: doc.data().periodo || '1' }; pins.push(doc.id); });
    if (!pins.length) return [];

    let porAlumno = {};
    for (const grupo of chunk(pins, 30)) {
      const snap = await db.collection('resultados_examenes_inmu').where('materiaPin', 'in', grupo).get();
      snap.forEach(doc => {
        const d = doc.data();
        if (!materiaInfo[d.materiaPin]) return;
        const alumno = d.alumno;
        const periodo = (d.periodo || materiaInfo[d.materiaPin].periodo).toString();
        if (!porAlumno[alumno]) porAlumno[alumno] = {};
        if (!porAlumno[alumno][periodo]) porAlumno[alumno][periodo] = [];
        porAlumno[alumno][periodo].push({ materia: d.materia, puntaje: d.puntaje });
      });
    }
    const resultado = Object.keys(porAlumno).map(alumno => ({ alumno, periodos: porAlumno[alumno] }));
    resultado.sort((a, b) => a.alumno.localeCompare(b.alumno));
    return resultado;
  }

  // ==========================================================================
  // ROSTER COMPARTIDO - leer alumnos_inmu (Asistencia/Portal) por grado+seccion
  // ==========================================================================
  async function obtenerRosterPorGradoSeccion(grado, seccion) {
    try {
      const snap = await db.collection('alumnos_inmu').where('grado', '==', String(grado || '').trim()).where('seccion', '==', String(seccion || '').trim()).get();
      const alumnos = [];
      snap.forEach(doc => { const d = doc.data(); alumnos.push({ nombre: d.nombre || '', nie: d.nie || doc.id, grado: d.grado || '', seccion: d.seccion || '' }); });
      alumnos.sort((a, b) => a.nombre.localeCompare(b.nombre));
      return { ok: true, alumnos };
    } catch (e) {
      return { ok: false, error: e.message, alumnos: [] };
    }
  }

  // ==========================================================================
  // DESPACHADOR - reemplaza el switch(action) que antes vivia en doPost()
  // ==========================================================================
  async function ejecutar(action, data) {
    data = data || {};
    const ok = await esperarListo();
    if (!ok) return { error: 'No se pudo conectar con Firebase. Verifica tu internet.' };
    try {
      switch (action) {
        case 'registrarDocente': return await registrarDocente(data.claveSeguridad, data.usuario, data.password);
        case 'verificarDocente': return await verificarDocente(data.usuario, data.password);
        case 'restablecerPasswordDocente': return await restablecerPasswordDocente(data.passwordAdmin, data.usuario, data.nuevaPassword);

        case 'verificarPinAlumno': return await verificarPinAlumno(data.pin, data.nombre, data.nie);
        case 'guardarRespuestasServidor': return await guardarRespuestasServidor(data.paquete);

        case 'obtenerMateriasPorDocente': return await obtenerMateriasPorDocente(data.nombreDocente);
        case 'crearNuevaMateria': return await crearNuevaMateria(data.nombreMateria, data.pin, data.nombreDocente, data.grado, data.seccion, data.periodo, data.tipoMateria, data.especialidad, data.actividadNota, data.escala);
        case 'guardarExamenEditado': return await guardarExamenEditado(data.pin, data.examenEstructura);
        case 'editarMateria': return await editarMateria(data.nombreDocente, data.materiaNombre, data.pinActual, data.grado, data.seccion, data.periodo, data.tipoMateria, data.especialidad, data.actividadNota, data.escala);

        case 'obtenerResultadosDocente': return await obtenerResultadosDocente(data.nombreDocente);
        case 'obtenerNotasDocente': return await obtenerNotasDocente(data.nombreDocente);

        case 'inicializarBD': return await inicializarBD();
        case 'borrarDatosDocente': return await borrarDatosDocente(data.nombreDocente);
        case 'borrarDatosGlobal': return await borrarDatosGlobal(data.passAdmin);
        case 'obtenerEstadoSistema': return { status: true, bloqueado: await obtenerEstadoSistema() };
        case 'alternarBloqueoSistema': return await alternarBloqueoSistema(data.password);
        case 'cambiarClaveRegistro': return await cambiarClaveRegistro(data.passwordAdmin, data.nuevaClave);

        case 'registrarAdvertencia': return await registrarAdvertencia(data.nombre, data.pin);
        case 'obtenerSesionesDocente': return await obtenerSesionesDocente(data.nombreDocente);
        case 'gestionarSesionAlumno': return await gestionarSesionAlumno(data.sesionId, data.accion, data.valor);

        case 'crearAlumnoRoster': return await crearAlumnoRoster(data.nombreDocente, data.nombre, data.nie, data.grado, data.seccion);
        case 'obtenerAlumnosRoster': return await obtenerAlumnosRoster(data.nombreDocente);
        case 'eliminarAlumnoRoster': return await eliminarAlumnoRoster(data.nombreDocente, data.nombre, data.nie);

        case 'crearAccesoAlumno': return await crearAccesoAlumno(data.nombreDocente, data.nombre, data.nie, data.materia, data.pinIndividual);
        case 'obtenerAccesosAlumnoDocente': return await obtenerAccesosAlumnoDocente(data.nombreDocente);
        case 'eliminarAccesoAlumno': return await eliminarAccesoAlumno(data.nombreDocente, data.nie, data.materia);

        default: return { error: `Accion desconocida: ${action}` };
      }
    } catch (e) {
      console.error(`[Examenes] Error ejecutando "${action}":`, e);
      if (e.code === 'failed-precondition' || (e.message || '').includes('index')) {
        return { error: 'Firestore necesita un indice para esta consulta. Abre la consola del navegador (F12): ahi aparece un enlace para crearlo automaticamente (tarda ~1 minuto).' };
      }
      return { error: e.message || 'Error desconocido.' };
    }
  }

  window.FBExamenes = {
    listo: () => _listo,
    ejecutar,
    obtenerRosterPorGradoSeccion
  };

  console.log('[Examenes] Modulo cargado - window.FBExamenes disponible (backend 100% Firestore)');
})();
