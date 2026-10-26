const container = document.getElementById('api-docs');
const style = document.createElement('style');
style.textContent = 'body{margin:0;font-family:system-ui,sans-serif}header{padding:1rem;background:#222;color:#fff;border-bottom:2px solid #F05F40}header h1{font-size:1.4rem}header a{color:#fcc650}';
document.head.appendChild(style);
if (document.body.dataset.renderer === 'swagger' && window.SwaggerUIBundle) {
  window.SwaggerUIBundle({
    url: '/openapi.json',
    dom_id: '#api-docs',
    supportedSubmitMethods: [],
    validatorUrl: null,
    persistAuthorization: false,
    withCredentials: false,
    queryConfigEnabled: false,
  });
} else if (window.Redoc) {
  window.Redoc.init('/openapi.json', {
    untrustedSpec: true,
    disableGoogleFont: true,
    theme: { colors: { primary: { main: '#F05F40' } } },
  }, container);
} else {
  container.textContent = 'Não foi possível carregar o visualizador. Consulte o link OpenAPI JSON.';
}
