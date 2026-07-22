// ==========================================
// CONFIGURACIÓN PRINCIPAL
// ==========================================
// 1. PEGA AQUÍ EL ID DE TU GOOGLE SHEETS (Está en la URL de tu hoja de cálculo)
const SHEET_ID = 'PEGAR_ID_DE_GOOGLE_SHEETS_AQUI';

// ==========================================
// RECEPCIÓN DE PETICIONES DESDE GITHUB PAGES
// ==========================================
function doPost(e) {
  try {
    const params = JSON.parse(e.postData.contents);
    const action = params.action;
    const data = params.data;
    let result;

    switch(action) {
      // --- Cuentas de docente ---
      case 'registrarDocente': result = registrarDocente(data.claveSeguridad, data.usuario, data.password); break;
      case 'verificarDocente': result = verificarDocente(data.usuario, data.password); break;

      // --- Alumno / examen ---
      case 'verificarPinAlumno': result = verificarPinAlumno(data.pin, data.nombre, data.nie); break;
      case 'guardarRespuestasServidor': result = guardarRespuestasServidor(data.paquete); break;

      // --- Materias / exámenes ---
      case 'obtenerMateriasPorDocente': result = obtenerMateriasPorDocente(data.nombreDocente); break;
      case 'crearNuevaMateria': result = crearNuevaMateria(data.nombreMateria, data.pin, data.nombreDocente, data.grado, data.seccion, data.periodo); break;
      case 'guardarExamenEditado': result = guardarExamenEditado(data.pin, data.examenEstructura); break;
      case 'editarMateria': result = editarMateria(data.nombreDocente, data.materiaNombre, data.pinActual, data.grado, data.seccion, data.periodo); break;

      // --- Resultados / notas ---
      case 'obtenerResultadosDocente': result = obtenerResultadosDocente(data.nombreDocente); break;
      case 'obtenerNotasDocente': result = obtenerNotasDocente(data.nombreDocente); break;

      // --- Sistema / mantenimiento ---
      case 'inicializarBD': result = inicializarBD(); break;
      case 'borrarDatosDocente': result = borrarDatosDocente(data.nombreDocente); break;
      case 'borrarDatosGlobal': result = borrarDatosGlobal(data.passAdmin); break;
      case 'obtenerEstadoSistema': result = { status: true, bloqueado: obtenerEstadoSistema() }; break;
      case 'alternarBloqueoSistema': result = alternarBloqueoSistema(data.password); break;
      case 'cambiarClaveRegistro': result = cambiarClaveRegistro(data.passwordAdmin, data.nuevaClave); break;

      // --- Control anti-copia / sesiones ---
      case 'registrarAdvertencia': result = registrarAdvertencia(data.nombre, data.pin); break;
      case 'obtenerSesionesDocente': result = obtenerSesionesDocente(data.nombreDocente); break;
      case 'gestionarSesionAlumno': result = gestionarSesionAlumno(data.nombre, data.materia, data.accion, data.valor); break;

      // --- Registro de alumnos (roster) ---
      case 'crearAlumnoRoster': result = crearAlumnoRoster(data.nombreDocente, data.nombre, data.nie, data.grado, data.seccion); break;
      case 'obtenerAlumnosRoster': result = obtenerAlumnosRoster(data.nombreDocente); break;
      case 'eliminarAlumnoRoster': result = eliminarAlumnoRoster(data.nombreDocente, data.nombre, data.nie); break;

      // --- Accesos especiales por NIE ---
      case 'crearAccesoAlumno': result = crearAccesoAlumno(data.nombreDocente, data.nombre, data.nie, data.materia, data.pinIndividual); break;
      case 'obtenerAccesosAlumnoDocente': result = obtenerAccesosAlumnoDocente(data.nombreDocente); break;
      case 'eliminarAccesoAlumno': result = eliminarAccesoAlumno(data.nombreDocente, data.nie, data.materia); break;

      default: result = { error: "Acción no válida" };
    }

    return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
  } catch(err) {
    return ContentService.createTextOutput(JSON.stringify({ error: err.toString(), status: false })).setMimeType(ContentService.MimeType.JSON);
  }
}

// ==========================================
// AUXILIARES
// ==========================================
function getHoja(nombre) {
  return SpreadsheetApp.openById(SHEET_ID).getSheetByName(nombre);
}

function normalizarNombre(nombre) {
  return nombre.toString().trim().toUpperCase().replace(/\s+/g, ' ');
}

function hashPassword(pw) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, pw);
  return bytes.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}

// Limpia espacios y normaliza guiones "raros" (que algunos teclados de celular
// insertan en vez de un guion normal) antes de comparar claves maestras.
function limpiarClave(v) {
  return (v || '').toString().trim().replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, '-');
}

// ==========================================
// APAGADO DE EMERGENCIA (KILL SWITCH)
// ==========================================
function obtenerEstadoSistema() {
  return PropertiesService.getScriptProperties().getProperty('SISTEMA_BLOQUEADO') === 'true';
}

function alternarBloqueoSistema(password) {
  if (limpiarClave(password) !== "747-8") return { error: "Contraseña de administrador incorrecta" };
  const props = PropertiesService.getScriptProperties();
  const nuevoEstado = !(props.getProperty('SISTEMA_BLOQUEADO') === 'true');
  props.setProperty('SISTEMA_BLOQUEADO', nuevoEstado.toString());
  return { status: true, bloqueado: nuevoEstado };
}

// El PIN que deben usar los docentes para crear su cuenta. Por defecto es "747-8",
// pero el administrador puede cambiarlo a cualquier valor con cambiarClaveRegistro().
function obtenerClaveRegistroDocente() {
  const guardada = PropertiesService.getScriptProperties().getProperty('CLAVE_REGISTRO_DOCENTE');
  return guardada || '747-8';
}

// Solo quien conoce la clave maestra de administrador (747-8) puede cambiar el PIN
// de registro de docentes, y puede ponerlo como quiera.
function cambiarClaveRegistro(passwordAdmin, nuevaClave) {
  if (limpiarClave(passwordAdmin) !== "747-8") return { status: false, error: "Clave maestra de administrador incorrecta." };
  const clave = limpiarClave(nuevaClave);
  if (!clave) return { status: false, error: "La nueva clave no puede estar vacía." };
  PropertiesService.getScriptProperties().setProperty('CLAVE_REGISTRO_DOCENTE', clave);
  return { status: true, msg: "PIN de registro de docentes actualizado correctamente." };
}

// ==========================================
// CUENTAS DE DOCENTE
// ==========================================
// Crear una cuenta nueva requiere el PIN de seguridad del plantel (clave maestra: 747-8)
function registrarDocente(claveSeguridad, usuarioRaw, password) {
  if (limpiarClave(claveSeguridad) !== obtenerClaveRegistroDocente()) return { status: false, error: "PIN de seguridad incorrecto." };
  if (!usuarioRaw || !password || password.toString().length < 4) {
    return { status: false, error: "Usuario y contraseña (mínimo 4 caracteres) son obligatorios." };
  }
  const usuario = usuarioRaw.toString().trim().toUpperCase();
  const sheet = getHoja('Docentes');
  if (!sheet) return { status: false, error: "La hoja 'Docentes' no existe. Ve a Configuración > Inicializar Base de Datos." };

  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === usuario) return { status: false, error: "Ese usuario ya existe. Elige otro." };
  }
  sheet.appendRow([usuario, hashPassword(password.toString()), new Date()]);
  return { status: true, msg: "Cuenta creada con éxito. Ya puedes iniciar sesión." };
}

function verificarDocente(usuarioRaw, password) {
  const usuario = (usuarioRaw || '').toString().trim().toUpperCase();
  const sheet = getHoja('Docentes');
  if (!sheet) return { status: false, error: "Base de datos no inicializada. Ve a Configuración una vez tengas una cuenta, o pide al administrador que inicialice la BD." };

  const data = sheet.getDataRange().getValues();
  const hash = hashPassword((password || '').toString());
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === usuario && data[i][1] === hash) return { status: true, nombre: usuario };
  }
  return { status: false, error: "Usuario o contraseña incorrectos." };
}

// ==========================================
// LÓGICA DE ALUMNO: INGRESO AL EXAMEN
// ==========================================
// Verifica el PIN del alumno. Contempla 3 vías de ingreso:
//  1) NIE + PIN individual (acceso especial creado por el docente para casos con problemas)
//  2) Nombre completo + PIN normal de la materia
//  3) Nombre completo + PIN de reingreso especial (si el alumno fue bloqueado por cambio de ventana)
function verificarPinAlumno(pin, nombreRaw, nieRaw) {
  if (obtenerEstadoSistema()) return { status: false, error: "SISTEMA_CAIDO" };

  const nie = (nieRaw || '').toString().trim();
  const sheetMat = getHoja('Materias');
  const sheetSes = getHoja('Sesiones');
  const sheetAcc = getHoja('AlumnosAcceso');
  if (!sheetMat) return { status: false, error: "Base de datos no inicializada." };
  const dataMat = sheetMat.getDataRange().getValues();

  // 1) Acceso especial por NIE + PIN individual
  if (nie && sheetAcc) {
    const dataAcc = sheetAcc.getDataRange().getValues();
    for (let i = 1; i < dataAcc.length; i++) {
      if (dataAcc[i][1].toString() === nie && dataAcc[i][3].toString() === pin) {
        const materiaNombre = dataAcc[i][2];
        const nombreOficial = normalizarNombre(dataAcc[i][0] || nombreRaw || nie);
        for (let j = 1; j < dataMat.length; j++) {
          if (dataMat[j][0] === materiaNombre) {
            const examen = dataMat[j][3] ? JSON.parse(dataMat[j][3]) : [];
            return procesarIngresoSesion(sheetSes, nombreOficial, materiaNombre, pin, examen, nie);
          }
        }
        return { status: false, error: "El acceso especial existe pero la materia ya no está disponible." };
      }
    }
  }

  const nombre = normalizarNombre(nombreRaw);
  if (nombre.split(' ').filter(Boolean).length < 3) {
    return { status: false, error: "Escribe tu nombre completo en MAYÚSCULAS y sin tildes (nombre y apellidos). Ej: JOSE EMERSON CASTRO PEREZ" };
  }

  // 2) PIN normal de materia
  for (let i = 1; i < dataMat.length; i++) {
    if (dataMat[i][1].toString() === pin) {
      const materiaNombre = dataMat[i][0];
      const examen = dataMat[i][3] ? JSON.parse(dataMat[i][3]) : [];
      return procesarIngresoSesion(sheetSes, nombre, materiaNombre, pin, examen, nie);
    }
  }

  // 3) PIN de reingreso especial (alumno bloqueado)
  if (sheetSes) {
    const dataSes = sheetSes.getDataRange().getValues();
    for (let i = 1; i < dataSes.length; i++) {
      const filaNombre = dataSes[i][0];
      const estado = dataSes[i][4];
      const pinReingreso = dataSes[i][5] ? dataSes[i][5].toString() : '';
      if (filaNombre === nombre && estado === 'BLOQUEADO' && pinReingreso && pinReingreso === pin) {
        const materiaNombre = dataSes[i][1];
        for (let j = 1; j < dataMat.length; j++) {
          if (dataMat[j][0] === materiaNombre) {
            const examen = dataMat[j][3] ? JSON.parse(dataMat[j][3]) : [];
            sheetSes.getRange(i + 1, 5).setValue('ACTIVO');
            sheetSes.getRange(i + 1, 8).setValue(new Date());
            return { status: true, materia: materiaNombre, examen: examen };
          }
        }
      }
    }
  }

  return { status: false, error: "PIN incorrecto o materia no encontrada." };
}

// Crea o recupera la sesión de un alumno para una materia. Controla los estados
// ACTIVO / BLOQUEADO / FINALIZADO.
function procesarIngresoSesion(sheetSes, nombre, materiaNombre, pinMateria, examen, nie) {
  if (!sheetSes) return { status: true, materia: materiaNombre, examen: examen };

  const dataSes = sheetSes.getDataRange().getValues();
  for (let i = 1; i < dataSes.length; i++) {
    if (dataSes[i][0] === nombre && dataSes[i][1] === materiaNombre) {
      const estado = dataSes[i][4];
      if (estado === 'FINALIZADO') {
        return { status: false, error: "Ya finalizaste este examen. No puedes volver a ingresar." };
      }
      if (estado === 'BLOQUEADO') {
        return { status: false, error: "Tu examen fue bloqueado por cambios de ventana. Pide a tu docente un PIN especial diferente para continuar.", bloqueado: true };
      }
      sheetSes.getRange(i + 1, 8).setValue(new Date());
      return { status: true, materia: materiaNombre, examen: examen };
    }
  }

  sheetSes.appendRow([nombre, materiaNombre, pinMateria, 0, 'ACTIVO', '', new Date(), new Date(), nie || '']);
  return { status: true, materia: materiaNombre, examen: examen };
}

// Registra un cambio de ventana/pestaña detectado por el cliente durante el examen.
function registrarAdvertencia(nombreRaw, pin) {
  const nombre = normalizarNombre(nombreRaw);
  const sheetMat = getHoja('Materias');
  const sheetSes = getHoja('Sesiones');
  if (!sheetMat || !sheetSes) return { status: false, error: "Base de datos no inicializada." };

  const dataMat = sheetMat.getDataRange().getValues();
  let materiaNombre = null;
  for (let i = 1; i < dataMat.length; i++) {
    if (dataMat[i][1].toString() === pin) { materiaNombre = dataMat[i][0]; break; }
  }
  if (!materiaNombre) return { status: false, error: "Materia no encontrada." };

  const dataSes = sheetSes.getDataRange().getValues();
  for (let i = 1; i < dataSes.length; i++) {
    if (dataSes[i][0] === nombre && dataSes[i][1] === materiaNombre) {
      const advertencias = (Number(dataSes[i][3]) || 0) + 1;
      sheetSes.getRange(i + 1, 4).setValue(advertencias);
      sheetSes.getRange(i + 1, 8).setValue(new Date());
      if (advertencias >= 2) {
        sheetSes.getRange(i + 1, 5).setValue('BLOQUEADO');
        return { status: true, bloqueado: true, advertencias: advertencias };
      }
      return { status: true, bloqueado: false, advertencias: advertencias };
    }
  }

  sheetSes.appendRow([nombre, materiaNombre, pin, 1, 'ACTIVO', '', new Date(), new Date(), '']);
  return { status: true, bloqueado: false, advertencias: 1 };
}

function obtenerSesionesDocente(nombreDocente) {
  const sheetMat = getHoja('Materias');
  const sheetSes = getHoja('Sesiones');
  if (!sheetMat || !sheetSes) return [];

  const nombreUpper = nombreDocente.toUpperCase();
  const dataMat = sheetMat.getDataRange().getValues();
  let misMaterias = [];
  for (let i = 1; i < dataMat.length; i++) {
    if (dataMat[i][2].toString().toUpperCase() === nombreUpper) misMaterias.push(dataMat[i][0]);
  }

  const dataSes = sheetSes.getDataRange().getValues();
  let sesiones = [];
  for (let i = 1; i < dataSes.length; i++) {
    if (misMaterias.includes(dataSes[i][1])) {
      sesiones.push({
        nombre: dataSes[i][0], materia: dataSes[i][1], advertencias: dataSes[i][3], estado: dataSes[i][4],
        pinReingreso: dataSes[i][5], fechaInicio: dataSes[i][6], fechaActualizacion: dataSes[i][7], nie: dataSes[i][8] || ''
      });
    }
  }
  sesiones.reverse();
  return sesiones;
}

function gestionarSesionAlumno(nombreRaw, materia, accion, valor) {
  const nombre = normalizarNombre(nombreRaw);
  const sheetSes = getHoja('Sesiones');
  if (!sheetSes) return { status: false, error: "Base de datos no inicializada." };

  const dataSes = sheetSes.getDataRange().getValues();
  for (let i = 1; i < dataSes.length; i++) {
    if (dataSes[i][0] === nombre && dataSes[i][1] === materia) {
      if (accion === 'asignarPin') {
        const pinMateriaOriginal = dataSes[i][2] ? dataSes[i][2].toString() : '';
        let pin = (valor && valor.toString().trim()) ? valor.toString().trim() : '';
        if (!pin) {
          do { pin = Math.floor(1000 + Math.random() * 9000).toString(); } while (pin === pinMateriaOriginal);
        } else if (pin === pinMateriaOriginal) {
          return { status: false, error: "El PIN especial debe ser diferente al PIN normal de la materia." };
        }
        sheetSes.getRange(i + 1, 6).setValue(pin);
        sheetSes.getRange(i + 1, 8).setValue(new Date());
        return { status: true, pinReingreso: pin };
      }
      if (accion === 'desbloquear') {
        sheetSes.getRange(i + 1, 4).setValue(0);
        sheetSes.getRange(i + 1, 5).setValue('ACTIVO');
        sheetSes.getRange(i + 1, 6).setValue('');
        sheetSes.getRange(i + 1, 8).setValue(new Date());
        return { status: true };
      }
      return { status: false, error: "Acción no válida." };
    }
  }
  return { status: false, error: "Sesión de alumno no encontrada." };
}

// ==========================================
// REGISTRO DE ALUMNOS (ROSTER: nombre + NIE + grado/sección)
// ==========================================
function crearAlumnoRoster(nombreDocente, nombreRaw, nie, grado, seccion) {
  const sheet = getHoja('Alumnos');
  if (!sheet) return { status: false, error: "La hoja 'Alumnos' no existe. Ve a Configuración > Inicializar Base de Datos." };
  const nombre = normalizarNombre(nombreRaw);
  const nombreDocUpper = nombreDocente.toUpperCase();

  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][4].toString().toUpperCase() === nombreDocUpper && data[i][0] === nombre) {
      sheet.getRange(i + 1, 1, 1, 4).setValues([[nombre, nie || '', grado || '', seccion || '']]);
      return { status: true, msg: "Alumno actualizado en el registro." };
    }
  }
  sheet.appendRow([nombre, nie || '', grado || '', seccion || '', nombreDocUpper, new Date()]);
  return { status: true, msg: "Alumno agregado al registro." };
}

function obtenerAlumnosRoster(nombreDocente) {
  const sheet = getHoja('Alumnos');
  if (!sheet) return [];
  const nombreDocUpper = nombreDocente.toUpperCase();
  const data = sheet.getDataRange().getValues();
  let out = [];
  for (let i = 1; i < data.length; i++) {
    if (data[i][4].toString().toUpperCase() === nombreDocUpper) {
      out.push({ nombre: data[i][0], nie: data[i][1], grado: data[i][2], seccion: data[i][3] });
    }
  }
  return out;
}

function eliminarAlumnoRoster(nombreDocente, nombreRaw, nie) {
  const sheet = getHoja('Alumnos');
  if (!sheet) return { status: false, error: "Base de datos no inicializada." };
  const nombre = normalizarNombre(nombreRaw);
  const nombreDocUpper = nombreDocente.toUpperCase();
  const data = sheet.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    if (data[i][4].toString().toUpperCase() === nombreDocUpper && data[i][0] === nombre && (data[i][1] || '').toString() === (nie || '').toString()) {
      sheet.deleteRow(i + 1);
      return { status: true };
    }
  }
  return { status: false, error: "Alumno no encontrado en el registro." };
}

// ==========================================
// ACCESOS ESPECIALES POR NIE (para alumnos con problemas de ingreso)
// ==========================================
function crearAccesoAlumno(nombreDocente, nombreRaw, nie, materiaNombre, pinIndividualRaw) {
  const sheetMat = getHoja('Materias');
  const sheetAcc = getHoja('AlumnosAcceso');
  if (!sheetMat || !sheetAcc) return { status: false, error: "Base de datos no inicializada." };
  if (!nie) return { status: false, error: "El NIE es obligatorio para crear el acceso especial." };
  if (!materiaNombre) return { status: false, error: "Selecciona una materia." };

  const dataMat = sheetMat.getDataRange().getValues();
  let pinMateriaOriginal = null;
  let ok = false;
  for (let i = 1; i < dataMat.length; i++) {
    if (dataMat[i][0] === materiaNombre && dataMat[i][2].toString().toUpperCase() === nombreDocente.toUpperCase()) {
      ok = true; pinMateriaOriginal = dataMat[i][1].toString(); break;
    }
  }
  if (!ok) return { status: false, error: "Esa materia no existe o no te pertenece." };

  let pin = (pinIndividualRaw && pinIndividualRaw.toString().trim()) ? pinIndividualRaw.toString().trim() : '';
  if (!pin) {
    do { pin = Math.floor(1000 + Math.random() * 9000).toString(); } while (pin === pinMateriaOriginal);
  } else if (pin === pinMateriaOriginal) {
    return { status: false, error: "El PIN individual debe ser diferente al PIN normal de la materia." };
  }

  const nombre = normalizarNombre(nombreRaw || nie);
  const dataAcc = sheetAcc.getDataRange().getValues();
  for (let i = 1; i < dataAcc.length; i++) {
    if (dataAcc[i][1].toString() === nie && dataAcc[i][2] === materiaNombre) {
      sheetAcc.getRange(i + 1, 1, 1, 4).setValues([[nombre, nie, materiaNombre, pin]]);
      return { status: true, pin: pin, msg: "Acceso especial actualizado." };
    }
  }
  sheetAcc.appendRow([nombre, nie, materiaNombre, pin, nombreDocente.toUpperCase(), new Date()]);
  return { status: true, pin: pin, msg: "Acceso especial creado." };
}

function obtenerAccesosAlumnoDocente(nombreDocente) {
  const sheetMat = getHoja('Materias');
  const sheetAcc = getHoja('AlumnosAcceso');
  if (!sheetMat || !sheetAcc) return [];
  const nombreUpper = nombreDocente.toUpperCase();
  const dataMat = sheetMat.getDataRange().getValues();
  let misMaterias = [];
  for (let i = 1; i < dataMat.length; i++) {
    if (dataMat[i][2].toString().toUpperCase() === nombreUpper) misMaterias.push(dataMat[i][0]);
  }
  const dataAcc = sheetAcc.getDataRange().getValues();
  let out = [];
  for (let i = 1; i < dataAcc.length; i++) {
    if (misMaterias.includes(dataAcc[i][2])) {
      out.push({ nombre: dataAcc[i][0], nie: dataAcc[i][1], materia: dataAcc[i][2], pin: dataAcc[i][3] });
    }
  }
  return out;
}

function eliminarAccesoAlumno(nombreDocente, nie, materiaNombre) {
  const sheetAcc = getHoja('AlumnosAcceso');
  if (!sheetAcc) return { status: false, error: "Base de datos no inicializada." };
  const dataAcc = sheetAcc.getDataRange().getValues();
  for (let i = dataAcc.length - 1; i >= 1; i--) {
    if (dataAcc[i][1].toString() === nie && dataAcc[i][2] === materiaNombre && dataAcc[i][4].toString().toUpperCase() === nombreDocente.toUpperCase()) {
      sheetAcc.deleteRow(i + 1);
      return { status: true };
    }
  }
  return { status: false, error: "Acceso no encontrado." };
}

// ==========================================
// LÓGICA DEL DOCENTE: MATERIAS / EXÁMENES
// ==========================================
function obtenerMateriasPorDocente(nombreDocente) {
  const sheet = getHoja('Materias');
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  let materias = [];
  for (let i = 1; i < data.length; i++) {
    if (data[i][2].toString().toUpperCase() === nombreDocente.toUpperCase()) {
      materias.push({
        materia: data[i][0], pin: data[i][1], examen: data[i][3] ? JSON.parse(data[i][3]) : [],
        grado: data[i][4] || '', seccion: data[i][5] || '', periodo: data[i][6] || '1'
      });
    }
  }
  return materias;
}

function crearNuevaMateria(nombreMateria, pin, nombreDocente, grado, seccion, periodo) {
  const sheet = getHoja('Materias');
  if (!sheet) return { status: false, msg: "Inicialice la Base de Datos primero (Configuración > Inicializar Base de Datos)." };
  if (!nombreMateria || !pin) return { status: false, msg: "El nombre de la materia y el PIN son obligatorios." };

  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][1].toString() === pin.toString()) return { status: false, msg: "Ese PIN ya está en uso." };
  }
  sheet.appendRow([nombreMateria, pin, nombreDocente.toUpperCase(), "[]", grado || '', seccion || '', periodo || '1']);
  return { status: true, msg: "Materia creada con éxito." };
}

function guardarExamenEditado(pin, examenEstructura) {
  const sheet = getHoja('Materias');
  if (!sheet) return { status: false, error: "La hoja 'Materias' no existe. Ve a Configuración > Inicializar Base de Datos y vuelve a intentar." };
  if (!pin) return { status: false, error: "No se identificó la materia a guardar (falta el PIN)." };

  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][1].toString() === pin.toString()) {
      sheet.getRange(i + 1, 4).setValue(JSON.stringify(examenEstructura || []));
      return { status: true };
    }
  }
  return { status: false, error: "No se encontró ninguna materia con ese PIN. Puede que haya sido borrada." };
}

// Permite corregir Grado/Sección/Período de una materia ya creada (por ejemplo si
// quedó algún dato corrupto o mal escrito) sin tener que editar el spreadsheet a mano.
function editarMateria(nombreDocente, materiaNombre, pinActual, grado, seccion, periodo) {
  const sheet = getHoja('Materias');
  if (!sheet) return { status: false, error: "Base de datos no inicializada." };
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === materiaNombre && data[i][1].toString() === pinActual.toString() && data[i][2].toString().toUpperCase() === nombreDocente.toUpperCase()) {
      sheet.getRange(i + 1, 5, 1, 3).setValues([[grado || '', seccion || '', (periodo || '1').toString().trim() || '1']]);
      return { status: true, msg: "Materia actualizada correctamente." };
    }
  }
  return { status: false, error: "No se encontró esa materia (o no te pertenece)." };
}

// ==========================================
// CONFIGURACIÓN Y BASE DE DATOS
// ==========================================
function asegurarColumnas(sheet, headers) {
  const anchoActual = sheet.getLastColumn();
  const headerRow = anchoActual > 0 ? sheet.getRange(1, 1, 1, anchoActual).getValues()[0] : [];
  headers.forEach((h, idx) => {
    if (!headerRow[idx]) sheet.getRange(1, idx + 1).setValue(h);
  });
}

function inicializarBD() {
  const ss = SpreadsheetApp.openById(SHEET_ID);

  let sheetMaterias = ss.getSheetByName('Materias');
  if (!sheetMaterias) {
    sheetMaterias = ss.insertSheet('Materias');
    sheetMaterias.appendRow(['Materia', 'PIN', 'Docente', 'ExamenJSON', 'Grado', 'Seccion', 'Periodo']);
  } else {
    asegurarColumnas(sheetMaterias, ['Materia', 'PIN', 'Docente', 'ExamenJSON', 'Grado', 'Seccion', 'Periodo']);
  }

  let sheetResultados = ss.getSheetByName('Resultados');
  if (!sheetResultados) {
    sheetResultados = ss.insertSheet('Resultados');
    sheetResultados.appendRow(['Fecha', 'Alumno', 'Materia', 'Puntaje', 'DetalleJSON', 'Periodo']);
  } else {
    asegurarColumnas(sheetResultados, ['Fecha', 'Alumno', 'Materia', 'Puntaje', 'DetalleJSON', 'Periodo']);
  }

  let sheetSesiones = ss.getSheetByName('Sesiones');
  if (!sheetSesiones) {
    sheetSesiones = ss.insertSheet('Sesiones');
    sheetSesiones.appendRow(['Nombre', 'Materia', 'PinMateria', 'Advertencias', 'Estado', 'PinReingreso', 'FechaInicio', 'FechaActualizacion', 'NIE']);
  } else {
    asegurarColumnas(sheetSesiones, ['Nombre', 'Materia', 'PinMateria', 'Advertencias', 'Estado', 'PinReingreso', 'FechaInicio', 'FechaActualizacion', 'NIE']);
  }

  let sheetDocentes = ss.getSheetByName('Docentes');
  if (!sheetDocentes) {
    sheetDocentes = ss.insertSheet('Docentes');
    sheetDocentes.appendRow(['Usuario', 'PasswordHash', 'Fecha']);
  }

  let sheetAlumnos = ss.getSheetByName('Alumnos');
  if (!sheetAlumnos) {
    sheetAlumnos = ss.insertSheet('Alumnos');
    sheetAlumnos.appendRow(['Nombre', 'NIE', 'Grado', 'Seccion', 'Docente', 'Fecha']);
  }

  let sheetAcceso = ss.getSheetByName('AlumnosAcceso');
  if (!sheetAcceso) {
    sheetAcceso = ss.insertSheet('AlumnosAcceso');
    sheetAcceso.appendRow(['Nombre', 'NIE', 'Materia', 'PinIndividual', 'Docente', 'Fecha']);
  }

  return { status: true, msg: "Base de datos verificada y actualizada. Todas las hojas y columnas necesarias existen." };
}

function borrarDatosDocente(nombreDocente) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const nombreUpper = nombreDocente.toUpperCase();
  const sheetMaterias = ss.getSheetByName('Materias');
  let materiasDocente = [];

  if (sheetMaterias) {
    const dataM = sheetMaterias.getDataRange().getValues();
    for (let i = dataM.length - 1; i >= 1; i--) {
      if (dataM[i][2].toString().toUpperCase() === nombreUpper) {
        materiasDocente.push(dataM[i][0]);
        sheetMaterias.deleteRow(i + 1);
      }
    }
  }

  const sheetResultados = ss.getSheetByName('Resultados');
  if (sheetResultados && materiasDocente.length > 0) {
    const dataR = sheetResultados.getDataRange().getValues();
    for (let i = dataR.length - 1; i >= 1; i--) {
      if (materiasDocente.includes(dataR[i][2])) sheetResultados.deleteRow(i + 1);
    }
  }

  const sheetSesiones = ss.getSheetByName('Sesiones');
  if (sheetSesiones && materiasDocente.length > 0) {
    const dataS = sheetSesiones.getDataRange().getValues();
    for (let i = dataS.length - 1; i >= 1; i--) {
      if (materiasDocente.includes(dataS[i][1])) sheetSesiones.deleteRow(i + 1);
    }
  }

  const sheetAlumnos = ss.getSheetByName('Alumnos');
  if (sheetAlumnos) {
    const dataA = sheetAlumnos.getDataRange().getValues();
    for (let i = dataA.length - 1; i >= 1; i--) {
      if (dataA[i][4] && dataA[i][4].toString().toUpperCase() === nombreUpper) sheetAlumnos.deleteRow(i + 1);
    }
  }

  const sheetAcceso = ss.getSheetByName('AlumnosAcceso');
  if (sheetAcceso && materiasDocente.length > 0) {
    const dataAc = sheetAcceso.getDataRange().getValues();
    for (let i = dataAc.length - 1; i >= 1; i--) {
      if (materiasDocente.includes(dataAc[i][2])) sheetAcceso.deleteRow(i + 1);
    }
  }

  return { status: true, msg: "Tus materias, resultados, sesiones, alumnos y accesos han sido borrados." };
}

function borrarDatosGlobal(passAdmin) {
  if (limpiarClave(passAdmin) !== "747-8") return { status: false, msg: "Clave Maestra incorrecta." };
  const ss = SpreadsheetApp.openById(SHEET_ID);
  ['Materias', 'Resultados', 'Sesiones', 'Alumnos', 'AlumnosAcceso'].forEach(nombreHoja => {
    const s = ss.getSheetByName(nombreHoja);
    if (s && s.getLastRow() > 1) s.getRange(2, 1, s.getLastRow() - 1, s.getLastColumn()).clearContent();
  });
  return { status: true, msg: "Todos los datos del sistema han sido purgados (las cuentas de docentes se conservan)." };
}

// ==========================================
// LÓGICA DEL ALUMNO: ENVÍO Y CALIFICACIÓN
// ==========================================
// Soporta tres tipos de pregunta:
//   'unica'    -> opción única (índice correcto en preg.correctas[0])
//   'multiple' -> opción múltiple (índices correctos en preg.correctas)
//   'corta'    -> respuesta corta / fórmula matemática (texto, admite varias respuestas
//                  aceptadas separadas por coma en preg.respuestaCorta)
// Mantiene compatibilidad con exámenes antiguos (preg.correcta como texto).
function guardarRespuestasServidor(paquete) {
  if (obtenerEstadoSistema()) return { status: false, error: "SISTEMA_CAIDO" };
  const sheet = getHoja('Resultados');
  if (!sheet) return { status: false, error: "Error en Base de Datos." };

  let correctas = 0; let total = paquete.examenOriginal.length; let detalle = [];

  paquete.examenOriginal.forEach((preg, index) => {
    const tipo = preg.tipo || 'unica';
    let respuestaAlumno = paquete.respuestas[index];
    let esCorrecta = false;
    let mostrarResp = 'Sin responder';
    let correctaTexto = '';

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
    detalle.push({ pregunta: preg.pregunta, respuestaAlumno: mostrarResp, estado: esCorrecta ? "Correcto" : "Incorrecto", correctaTexto: correctaTexto });
  });

  let puntajeFinal = `${correctas} / ${total}`;

  let periodoMateria = '1';
  const sheetMat = getHoja('Materias');
  if (sheetMat) {
    const dataMat = sheetMat.getDataRange().getValues();
    for (let i = 1; i < dataMat.length; i++) {
      if (dataMat[i][0] === paquete.materia) { periodoMateria = dataMat[i][6] || '1'; break; }
    }
  }

  sheet.appendRow([new Date(), paquete.alumno, paquete.materia, puntajeFinal, JSON.stringify(detalle), periodoMateria]);

  const sheetSes = getHoja('Sesiones');
  if (sheetSes) {
    const nombre = normalizarNombre(paquete.alumno);
    const dataSes = sheetSes.getDataRange().getValues();
    for (let i = 1; i < dataSes.length; i++) {
      if (dataSes[i][0] === nombre && dataSes[i][1] === paquete.materia) {
        sheetSes.getRange(i + 1, 5).setValue('FINALIZADO');
        sheetSes.getRange(i + 1, 8).setValue(new Date());
        break;
      }
    }
  }

  return { status: true, puntaje: puntajeFinal };
}

function obtenerResultadosDocente(nombreDocente) {
  const sheetMaterias = getHoja('Materias');
  const sheetRes = getHoja('Resultados');
  if (!sheetMaterias || !sheetRes) return [];

  const dataMaterias = sheetMaterias.getDataRange().getValues();
  let misMaterias = [];
  for (let i = 1; i < dataMaterias.length; i++) {
    if (dataMaterias[i][2].toString().toUpperCase() === nombreDocente.toUpperCase()) misMaterias.push(dataMaterias[i][0]);
  }

  const dataRes = sheetRes.getDataRange().getValues();
  let resultados = [];
  for (let i = 1; i < dataRes.length; i++) {
    if (misMaterias.includes(dataRes[i][2])) {
      resultados.push({
        fecha: dataRes[i][0], alumno: dataRes[i][1], materia: dataRes[i][2], puntaje: dataRes[i][3],
        detalle: dataRes[i][4] ? JSON.parse(dataRes[i][4]) : [], periodo: dataRes[i][5] || '1'
      });
    }
  }
  return resultados;
}

// Agrupa las notas de cada alumno por período (1-4) para la vista de "Notas por Período"
function obtenerNotasDocente(nombreDocente) {
  const sheetMat = getHoja('Materias');
  const sheetRes = getHoja('Resultados');
  if (!sheetMat || !sheetRes) return [];

  const nombreUpper = nombreDocente.toUpperCase();
  const dataMat = sheetMat.getDataRange().getValues();
  let materiaInfo = {};
  for (let i = 1; i < dataMat.length; i++) {
    if (dataMat[i][2].toString().toUpperCase() === nombreUpper) {
      materiaInfo[dataMat[i][0]] = { periodo: dataMat[i][6] || '1' };
    }
  }

  const dataRes = sheetRes.getDataRange().getValues();
  let porAlumno = {};
  for (let i = 1; i < dataRes.length; i++) {
    const materia = dataRes[i][2];
    if (!materiaInfo[materia]) continue;
    const alumno = dataRes[i][1];
    const puntaje = dataRes[i][3];
    const periodo = (dataRes[i][5] || materiaInfo[materia].periodo).toString();
    if (!porAlumno[alumno]) porAlumno[alumno] = {};
    if (!porAlumno[alumno][periodo]) porAlumno[alumno][periodo] = [];
    porAlumno[alumno][periodo].push({ materia: materia, puntaje: puntaje });
  }

  let resultado = [];
  Object.keys(porAlumno).forEach(alumno => resultado.push({ alumno: alumno, periodos: porAlumno[alumno] }));
  resultado.sort((a, b) => a.alumno.localeCompare(b.alumno));
  return resultado;
}
