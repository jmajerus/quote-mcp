// The shell script, run as root on the server, that writes its settings file (generated.env) in a folder:
// the new file is written beside it and renamed into place, and nothing changes when the server has a
// setting the new file wouldn't (a key left empty in .env, say) rather than deleting it. The file from
// before there was one standard (env) is moved aside to env.replaced, readable by root only.

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function writeEnvScript(text, dir, group = "quote") {
  const file = `${dir}/generated.env`;
  const names = (f) => `sed -nE 's/^([A-Za-z_][A-Za-z0-9_]*)=.*/\\1/p' "${f}" | sort -u`;
  return `
new=$(mktemp ${dir}/.generated.XXXXXX)
printf %s ${shellQuote(Buffer.from(text).toString("base64"))} | base64 -d > "$new"
old=${file}; [ -f "$old" ] || old=${dir}/env
if [ -f "$old" ]; then
  missing=$(comm -23 <(${names("$old")}) <(${names("$new")}) | tr '\\n' ' ')
  if [ -n "$missing" ]; then
    rm -f "$new"
    echo "The server has settings that .env (and deploy/server.env) don't: $missing" >&2
    echo "Add them to .env and deploy again; nothing on the server was changed." >&2
    exit 3
  fi
fi
chgrp ${group} "$new" && chmod 0640 "$new" && mv "$new" ${file}
if [ -f ${dir}/env ]; then mv ${dir}/env ${dir}/env.replaced && chmod 0600 ${dir}/env.replaced; fi`;
}
