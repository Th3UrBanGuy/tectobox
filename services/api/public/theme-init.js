// Theme init: light default, persisted choice respected. Unknown values fall back to light.
// Loaded synchronously in <head> before first paint (CSP script-src 'self' blocks inline scripts).
(function(){try{var t=localStorage.getItem('tectonic-theme');if(t!=='dark'&&t!=='light')t='light';document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','light');}})();
