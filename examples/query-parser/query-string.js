function parseQuery(input) {
  const query = input.replace(/^\?/, '');

  return Object.fromEntries(query.split('&').map((part) => (
    part.split('=').map((value) => decodeURIComponent(value))
  )));
}

module.exports = { parseQuery };
