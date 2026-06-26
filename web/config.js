// Browser app site configuration.
//
// Loaded before app.js. The default below is for serving the repository
// locally, where data/attachments/ is available alongside web/. The GitHub
// Pages deploy workflow overwrites this file with attachmentsLocal:false,
// since attachments are not published to Pages; attachment links then fall
// back to the original Discord CDN URLs.
window.DISCORD_HISTORY_CONFIG = { attachmentsLocal: true };
