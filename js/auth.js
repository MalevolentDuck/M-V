/**
 * Protezione accesso con token.
 *
 * Il token è nell'URL: ?t=TOKEN
 * Se corretto → mostra il contenuto e salva in sessionStorage
 * Se assente/errato → mostra solo la pagina gate (una emoji, nulla di rivelatore)
 *
 * Nota: questo NON è sicurezza crittografica. È sufficiente per impedire
 * l'accesso casuale — nessuno indovinerà il token, e il sito non è indicizzato.
 */

(function () {
    // ──── TOKEN DI ACCESSO ────
    // Cambia questo valore con il tuo token segreto
    const ACCESS_TOKEN = 'oXS7JtAoupGMfaToi4NN6kMFJGmw5-JTNusTzhzHxz0';

    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get('t');

    // Controlla token nell'URL o in sessionStorage (così navigando non si perde)
    const isAuthorized =
        urlToken === ACCESS_TOKEN ||
        sessionStorage.getItem('authorized') === 'true';

    const gate = document.getElementById('gate');
    const content = document.getElementById('content');

    if (isAuthorized) {
        // Accesso concesso
        sessionStorage.setItem('authorized', 'true');
        gate.style.display = 'none';
        content.style.display = 'block';

        // Pulisce il token dall'URL (così non si vede nella barra)
        if (urlToken) {
            const cleanUrl = window.location.origin + window.location.pathname;
            window.history.replaceState({}, '', cleanUrl);
        }
    } else {
        // Accesso negato — mostra solo il gate (una emoji innocua)
        gate.style.display = 'flex';
        content.style.display = 'none';
    }
})();
