#!/usr/bin/env bash
# Installs this app as a desktop application and the default folder handler.
# Re-runnable: every step overwrites only what it owns.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DESKTOP_DIR="$HOME/.local/share/applications"
DESKTOP_FILE="$DESKTOP_DIR/max-file-manager.desktop"
ICON="$APP_DIR/build/icon.png"
LAUNCHER="$HOME/.local/bin/max-file-manager-launch"

# Packaged build wins; otherwise run the repo in dev mode.
# electron-builder writes to release/ (see directories.output); dist/ is the old layout.
BIN=""
APP_PATH=""
if [ -x "$APP_DIR/release/linux-unpacked/max-file-manager" ]; then
  BIN="$APP_DIR/release/linux-unpacked/max-file-manager"
elif [ -x "$APP_DIR/dist/linux-unpacked/max-file-manager" ]; then
  BIN="$APP_DIR/dist/linux-unpacked/max-file-manager"
elif [ -x "$APP_DIR/node_modules/.bin/electron" ]; then
  BIN="$APP_DIR/node_modules/.bin/electron"
  APP_PATH="$APP_DIR"
else
  echo "no runnable build found in $APP_DIR" >&2
  exit 1
fi

# Ubuntu 23.10+ restricts unprivileged user namespaces for unconfined processes
# (kernel.apparmor_restrict_unprivileged_userns=1). The Chromium namespace sandbox cannot map
# uids there, so Chromium falls back to the SUID helper and aborts with "The SUID sandbox helper
# binary was found, but is not configured correctly" unless chrome-sandbox is root-owned 4755.
# A user-level install has no way to do that without root, so the launcher uses the same
# --no-sandbox fallback as electron-builder's AppImage — but only when no sandbox can work.
# A .deb install ships an AppArmor userns profile and keeps the sandbox.
mkdir -p "$HOME/.local/bin"
cat > "$LAUNCHER" <<EOF
#!/usr/bin/env bash
BIN=$(printf '%q' "$BIN")
APP_PATH=$(printf '%q' "$APP_PATH")
SANDBOX_OK=0
SB="\$(dirname -- "\$BIN")/chrome-sandbox"
if [ -x "\$SB" ] && [ "\$(stat -c '%u:%a' "\$SB" 2>/dev/null)" = "0:4755" ]; then
  SANDBOX_OK=1
fi
if [ "\$SANDBOX_OK" != 1 ] && command -v unshare >/dev/null 2>&1 && unshare --user --map-root-user true 2>/dev/null; then
  SANDBOX_OK=1
fi
if [ "\$SANDBOX_OK" != 1 ]; then
  set -- --no-sandbox "\$@"
fi
if [ -n "\$APP_PATH" ]; then
  set -- "\$APP_PATH" "\$@"
fi
exec "\$BIN" "\$@"
EOF
chmod +x "$LAUNCHER"
EXEC="$LAUNCHER %U"

mkdir -p "$DESKTOP_DIR"
cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=مدیر فایل مکس
Name[en]=Max File Manager
Comment=File manager (dual pane, tabs, sync)
Comment[en]=Dual-pane file manager
Exec=$EXEC
Icon=$ICON
Terminal=false
Categories=System;FileManager;Utility;
MimeType=inode/directory;x-scheme-handler/file;application/x-gnome-saved-search;
Keywords=files;manager;explorer;
StartupWMClass=max-file-manager
EOF
chmod 644 "$DESKTOP_FILE"

command -v update-desktop-database >/dev/null && update-desktop-database "$DESKTOP_DIR" || true

# Default handler for folders: this is what Firefox's "Open Containing Folder" and xdg-open use.
xdg-mime default max-file-manager.desktop inode/directory || true
xdg-mime default max-file-manager.desktop x-scheme-handler/file || true
xdg-mime default max-file-manager.desktop application/x-gnome-saved-search 2>/dev/null || true

echo "desktop entry : $DESKTOP_FILE"
echo "exec          : $EXEC"
echo "folder handler: $(xdg-mime query default inode/directory)"
echo "file handler  : $(xdg-mime query default x-scheme-handler/file)"
echo

if [ "${1:-}" = "--with-kde-shortcut" ] && command -v kwriteconfig6 >/dev/null; then
  # Plasma 6 has no khotkeys; custom shortcuts are created through System Settings, which stores
  # them in kglobalshortcutsrc. Writing that file directly is not a supported interface, so the
  # script only points at the exact dialog instead of guessing a schema.
  echo "KDE shortcut: System Settings → Keyboard → Shortcuts → Add → Command or Script:"
  echo "  $EXEC"
  echo "  then press Meta+E for it."
  exit 0
fi

cat <<EOF
KDE (Plasma 6): System Settings → Keyboard → Shortcuts → "Add" → "Command or Script",
paste:
  $EXEC
and assign Meta+E. (The in-app hotkey in Preferences works on X11 only; Wayland needs this step.)

Windows: Win+E is owned by Explorer, so a global hotkey cannot take it over from a normal app.
Use the in-app hotkey with a free combination (e.g. Ctrl+Alt+E) and, if you want Win+E itself,
either replace Explorer's binding with a keyboard remapper or run Explorer replacement mode.
EOF
