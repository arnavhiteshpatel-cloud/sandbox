#!/bin/bash
# Create a local, self-signed code-signing certificate named "JARVIS Local Signing" (once).
# Why: macOS ties permissions (Accessibility, Screen Recording, Microphone) to an app's signature.
# Ad-hoc signatures change with every build, so permissions would reset after each update.
# Signing every build with this certificate keeps permissions across rebuilds.
# The certificate never leaves this Mac and is only trusted for code signing on it.
set -euo pipefail
NAME="JARVIS Local Signing"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-identity -p codesigning 2>/dev/null | grep -q "\"$NAME\""; then
  echo "    signing identity \"$NAME\" already exists"
  exit 0
fi

echo "==> Creating the local code-signing certificate \"$NAME\" (macOS may ask for your password once)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/cfg" <<CFG
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
CFG
# /usr/bin/openssl is Apple's LibreSSL; its PKCS#12 format is what `security import` expects.
/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$TMP/cfg" \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" >/dev/null 2>&1
/usr/bin/openssl pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -name "$NAME" \
  -out "$TMP/id.p12" -passout pass:jarvis-local
security import "$TMP/id.p12" -k "$KEYCHAIN" -P jarvis-local -T /usr/bin/codesign >/dev/null
# Trust it for code signing only (shows a password dialog). Signing usually works even if this is skipped.
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$TMP/cert.pem" 2>/dev/null \
  || echo "    (trust setting skipped; signing will still be attempted)"
if security find-identity -p codesigning 2>/dev/null | grep -q "\"$NAME\""; then
  echo "    created \"$NAME\""
else
  echo "    could not create the identity; builds will use ad-hoc signing"
  exit 1
fi
