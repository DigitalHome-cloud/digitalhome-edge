const React = require("react");

// The theme before the first paint, so a light-theme reader never sees a dark
// flash. Dark is the default; the choice is kept in this browser only.
exports.onRenderBody = ({ setPreBodyComponents }) => {
  setPreBodyComponents([
    React.createElement("script", {
      key: "dhe-theme",
      dangerouslySetInnerHTML: {
        __html: "try{var t=localStorage.getItem('dhe.theme');document.documentElement.setAttribute('data-app-theme',t==='light'?'light':'dark')}catch(e){document.documentElement.setAttribute('data-app-theme','dark')}",
      },
    }),
  ]);
};
