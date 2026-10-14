// Vercel entry: vercel.json rewrites /api/<path> to /api/index?__path=<path>.
const { route } = require('../server');

module.exports = (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const sub = url.searchParams.get('__path') || '';
  url.searchParams.delete('__path');
  // Vercel also copies the rewrite's named segment into the query as `path`; it is not the caller's.
  if (url.searchParams.get('path') === sub) url.searchParams.delete('path');
  req.url = `/api/${sub}${url.search}`;
  return route(req, res);
};
