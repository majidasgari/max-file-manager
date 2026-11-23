#!/usr/bin/env bash
# Install the already-built Linux bundle for the current user and refresh the app-drawer entry.
# Re-runnable; it never changes the default file manager (use install-integration.sh for that).
# Run this after every pull/build so the installed app and the drawer always match the source.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$APP_DIR/release/linux-unpacked"
DEST="$HOME/.local/opt/max-file-manager"
BIN="$DEST/max-file-manager"
LAUNCHER="$DEST/max-file-manager-launch"
DESKTOP="$HOME/.local/share/applications/max-file-manager.desktop"
ICON="$HOME/.local/share/icons/hicolor/512x512/apps/max-file-manager.png"
VERSION="$(node -p "require('$APP_DIR/package.json').version" 2>/dev/null || echo unknown)"

if [ ! -f "$SRC/resources/app.asar" ] || [ -n "$(find "$APP_DIR/out" -newer "$SRC/resources/app.asar" 2>/dev/null | head -n 1)" ]; then
  (cd "$APP_DIR" && npx electron-builder --linux dir)
fi

if [ ! -x "$SRC/max-file-manager" ]; then
  echo "no packaged build in $SRC" >&2
  echo "run: npm run dist:linux" >&2
  exit 1
fi

mkdir -p "$DEST" "$HOME/.local/bin" "$HOME/.local/share/applications" "$(dirname "$ICON")"
rsync -a --delete "$SRC"/ "$DEST"/

# Ubuntu 23.10+ restricts unprivileged user namespaces for unconfined processes, so a user-level
# install cannot rely on the namespace sandbox; fall back to --no-sandbox only when no sandbox can
# work (same fail-safe as the AppImage). A .deb install ships an AppArmor profile instead.
cat > "$LAUNCHER" <<'EOF'
#!/bin/sh
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SANDBOX_OK=0
SB="$HERE/chrome-sandbox"
if [ -x "$SB" ] && [ "$(stat -c '%u:%a' "$SB" 2>/dev/null)" = "0:4755" ]; then
  SANDBOX_OK=1
fi
if [ "$SANDBOX_OK" != 1 ] && command -v unshare >/dev/null 2>&1 && unshare --user --map-root-user true 2>/dev/null; then
  SANDBOX_OK=1
fi
if [ "$SANDBOX_OK" != 1 ]; then
  set -- --no-sandbox "$@"
fi
exec "$HERE/max-file-manager" "$@"
EOF
chmod +x "$LAUNCHER"
ln -sfn "$BIN" "$HOME/.local/bin/max-file-manager"
cp -f "$APP_DIR/build/icon.png" "$ICON"

cat > "$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=Max File Manager
Name[fa]=مدیر فایل مکس
Comment=Dual-pane file manager with sync, rsync, age encryption and restic versions
Comment[fa]=مدیر فایل دوپنجره با همگام‌سازی، rsync، رمز age و نسخه‌های restic
Exec=$LAUNCHER %U
TryExec=$LAUNCHER
Icon=max-file-manager
Terminal=false
Categories=System;FileTools;FileManager;
MimeType=inode/directory;x-scheme-handler/file;application/x-gnome-saved-search;
Keywords=files;manager;sync;backup;
StartupWMClass=max-file-manager
EOF
chmod 644 "$DESKTOP"

command -v update-desktop-database >/dev/null && update-desktop-database "$HOME/.local/share/applications" || true
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" >/dev/null 2>&1 || true

echo "installed Max File Manager $VERSION"
echo "  app     : $DEST"
echo "  command : $HOME/.local/bin/max-file-manager"
echo "  drawer  : $DESKTOP"
echo "if the app is already running, quit and reopen it to load this build."
