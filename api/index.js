// Vercel entry: vercel.json rewrites /api/<path> to /api/index?__path=<path>.
const { route } = require('../server');

module.exports = (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const sub = url.searchParams.get('__path') || '';
  url.searchParams.delete('__path');
  req.url = `/api/${sub}${url.search}`;
  return route(req, res);
};
