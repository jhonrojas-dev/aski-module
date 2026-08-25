/** @odoo-module **/
// ---------------------------------------------------------------------------
// "¿Este usuario puede usar el chat?" — UNA sola vez por pestana.
// ---------------------------------------------------------------------------
// El permiso depende del MODO de acceso configurado (compartido al grupo / solo
// admin / por usuario) y NO cambia mientras el usuario tiene la pagina abierta.
//
// ⛔ Sin memoizar, el boton del chatter dispararia `can_use_chat` en CADA ficha
// que se abre: en una jornada normal son cientos de RPC identicos contra el
// mismo booleano. Se guarda la PROMESA (no el resultado) para que dos llamadas
// simultaneas —la burbuja al arrancar y el primer chatter— compartan la misma
// peticion en vez de lanzar dos.
//
// El `fetcher` lo pone quien llama porque el transporte cambia por serie
// (`orm.call` en 15+, `rpc.query` en la 14); la memoizacion es la misma.

let _promesa = null;

export function canUseChat(fetcher) {
    if (!_promesa) {
        _promesa = Promise.resolve()
            .then(fetcher)
            .then((v) => !!v)
            .catch(() => {
                // Sin respuesta (sin red, modulo a medio instalar) se asume que
                // NO puede: es mejor no ensenar un boton que abre un panel roto.
                // Se olvida la promesa fallida para que el siguiente intento —la
                // proxima ficha— vuelva a preguntar en vez de quedarse en no
                // para siempre por un fallo pasajero.
                _promesa = null;
                return false;
            });
    }
    return _promesa;
}
