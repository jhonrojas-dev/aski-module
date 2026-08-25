/** @odoo-module **/
// ---------------------------------------------------------------------------
// EL REGISTRO ABIERTO: que ficha del ERP esta mirando el usuario al preguntar.
// ---------------------------------------------------------------------------
// Quien lo pone: el boton "Aski" del chatter (aski_chatter.js).
// Quien lo lee: el panel de chat (pinta el chip y lo manda al backend) y la
// burbuja del systray (se abre sola cuando llega uno).
//
// ⛔ Por que un singleton con suscriptores y NO un servicio de wowl con
// `reactive`: este mismo fichero tiene que valer en las SEIS series. `reactive`
// no existe en OWL 1 (15/16) y los servicios de wowl no existen en la 14. Un
// objeto de modulo con una lista de callbacks es JavaScript a secas: identico en
// todas, sin una version por rama que mantener. Lo unico que cambia entre ramas
// es el envoltorio del modulo (`/** @odoo-module **/` aqui, `odoo.define` en 14).
//
// El ambito es SIEMPRE visible en el chat (chip con el nombre del registro) y se
// puede quitar. Un ambito invisible es la receta para que alguien lea una cifra
// creyendo que es del total cuando era de una ficha — la familia de quejas de
// "este numero no me cuadra".

const _estado = { model: null, resId: null, label: "" };
const _subs = new Set();

function _avisar() {
    // Copia por suscriptor: nadie puede mutar el estado compartido desde su
    // callback y dejarselo cambiado al siguiente.
    for (const fn of Array.from(_subs)) {
        try {
            fn(getRecord());
        } catch (e) {
            // Un suscriptor roto no puede dejar sin avisar a los demas: el chat
            // se quedaria con un chip que no corresponde al registro real.
        }
    }
}

/** El registro abierto ahora, o `{model: null}` si no hay ninguno. */
export function getRecord() {
    return { model: _estado.model, resId: _estado.resId, label: _estado.label };
}

/** True si hay un registro de verdad (modelo + id nuevo, no un formulario vacio). */
export function hasRecord() {
    return !!(_estado.model && _estado.resId);
}

/**
 * Fija el registro sobre el que se pregunta.
 * `resId` falsy (formulario nuevo sin guardar) equivale a limpiar: preguntar
 * sobre un registro que aun no existe no tiene respuesta posible.
 */
export function setRecord(model, resId, label) {
    const id = Number(resId) || 0;
    if (!model || id <= 0) {
        return clearRecord();
    }
    if (_estado.model === model && _estado.resId === id && _estado.label === (label || "")) {
        return; // mismo registro: no despertar a nadie
    }
    _estado.model = model;
    _estado.resId = id;
    _estado.label = label || "";
    _avisar();
}

/** Quita el ambito. Lo llama la × del chip y el chatter al desmontarse. */
export function clearRecord() {
    if (!_estado.model && !_estado.resId) {
        return;
    }
    _estado.model = null;
    _estado.resId = null;
    _estado.label = "";
    _avisar();
}

/**
 * Quita el ambito SOLO si apunta a este registro.
 * Lo usa el chatter al desmontarse: si el usuario se fue de la ficha, el ambito
 * deja de valer. Comprobar cual es evita que una ficha que se desmonta despues
 * de que otra ya fijo el suyo borre el ambito bueno.
 */
export function clearRecordIf(model, resId) {
    if (_estado.model === model && _estado.resId === (Number(resId) || 0)) {
        clearRecord();
    }
}

/** Se suscribe a los cambios. Devuelve la funcion para darse de baja. */
export function subscribe(fn) {
    _subs.add(fn);
    return () => _subs.delete(fn);
}

// --- Canal APARTE para "abre el panel" -------------------------------------
// ⛔ No vale deducir la apertura de un cambio de registro: si el usuario pulsa
// Aski, cierra el panel y vuelve a pulsar en la MISMA ficha, el registro no ha
// cambiado —`setRecord` sale antes de avisar— y el panel se quedaria cerrado.
// La peticion de abrir es un evento, no un estado.
const _subsAbrir = new Set();

/** Pide a la burbuja que se abra. La dispara el boton del chatter. */
export function requestOpen() {
    for (const fn of Array.from(_subsAbrir)) {
        try {
            fn();
        } catch (e) {
            // Un oyente roto no deja sin abrir a los demas.
        }
    }
}

/** Se suscribe a las peticiones de apertura. Devuelve la baja. */
export function onOpenRequest(fn) {
    _subsAbrir.add(fn);
    return () => _subsAbrir.delete(fn);
}
