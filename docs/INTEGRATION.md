# یکپارچگی با میزکار

## نصب و پیش‌نیاز

```bash
./scripts/install-integration.sh            # .desktop + هندلر پیش‌فرض پوشه‌ها
./scripts/install-integration.sh --with-kde-shortcut
./scripts/install-user.sh                   # نصب نسخهٔ بسته‌بندی‌شده در ~/.local/opt + منوی برنامه‌ها
```

اسکریپت این کارها را می‌کند:

1. `~/.local/share/applications/max-file-manager.desktop` را می‌سازد (با آیکون `build/icon.png`).
   اگر بیلد بسته‌بندی‌شده باشد همان باینری اجرا می‌شود، وگرنه Electron داخل مخزن.
   اجرا از راه `~/.local/bin/max-file-manager-launch` است: روی Wayland با `DISPLAY` موجود
   `--ozone-platform=x11` می‌دهد و اگر سندباکس Chromium در دسترس نباشد (اوبونتو ۲۴+ و نصب
   کاربری بدون `chrome-sandbox` روت) `--no-sandbox` — همان fallback خود AppImage.
2. `update-desktop-database` را اجرا می‌کند.
3. اپ را **هندلر پیش‌فرض `inode/directory` و `x-scheme-handler/file`** می‌کند:
   ```bash
   xdg-mime default max-file-manager.desktop inode/directory
   ```
4. راهنمای کلید میان‌بر KDE و محدودیت ویندوز را چاپ می‌کند.

## تک‌نمونه (single instance)

اپ با `app.requestSingleInstanceLock()` بالا می‌آید: اگر نسخهٔ دیگری باز باشد، نسخهٔ دوم بلافاصله
خارج می‌شود و **همان پنجرهٔ باز** را جلو می‌آورد و اگر مسیری به‌عنوان آرگومان داده شده باشد، آن را
در پنل فعال باز می‌کند (`app:open-path`).

اندازه‌گیری واقعی: نسخهٔ دوم با آرگومان مسیر در **۱۵۰۹ میلی‌ثانیه** با کد خروج ۰ تمام شد و نسخهٔ
اول باز ماند.

## «Open Containing Folder» فایرفاکس و `xdg-open`

فایرفاکس روی لینوکس برای «پوشهٔ شامل فایل را باز کن» هندلر پیش‌فرض سیستم برای `inode/directory`
را صدا می‌زند (و اگر آن نبود، `org.freedesktop.FileManager1` روی D-Bus). با اجرای اسکریپت نصب،
هندلر پیش‌فرض همین اپ می‌شود و مسیر پوشه به‌عنوان آرگومان به اپ می‌رسد:

```
xdg-mime query default inode/directory   # → max-file-manager.desktop
```

بررسی دستی: `xdg-open /tmp` باید همین اپ را باز کند.

**باقی‌مانده (در نقشهٔ راه):** پیاده‌سازی سرویس D-Bus `org.freedesktop.FileManager1`
(`ShowItems`/`ShowFolders`) تا برنامه‌هایی که مستقیم D-Bus را صدا می‌زنند (برخی فایل‌دیالوگ‌های
GTK، تلگرام دسکتاپ) هم همین اپ را باز کنند و فایلِ مشخص را انتخاب کند.

## کلید Win+E

### KDE Plasma 6

Plasma 6 `khotkeys` را حذف کرده و میان‌بر دلخواه از مسیر تنظیمات ساخته می‌شود:

1. System Settings → Keyboard → Shortcuts
2. **Add** → **Command or Script**
3. فرمان اسکریپت را کپی کن (همان که پرینت می‌شود) و بعد کلید **Meta+E** را بگیر.

### کلید سراسری داخل خود اپ

در تنظیمات → «راه‌اندازی» یک کلید سراسری هست (پیش‌فرض `Super+E`، قابل خاموش/روشن). این مسیر
`globalShortcut` الکترون را استفاده می‌کند:

- روی **X11** کار می‌کند — تأیید شده: `registerHotkey('Super+E')` → `{ok: true}` و
  `Ctrl+Alt+M` هم ثبت شد.
- روی **Wayland** فقط اگر پورتال `GlobalShortcuts` در دسترس باشد؛ وگرنه ثبت نمی‌شود و اپ خودش
  پیام می‌دهد «کلید ثبت نشد — در تنظیمات KDE به Add Command بده».

### ویندوز

`Win+E` مال Explorer است و یک اپ معمولی نمی‌تواند آن را بگیرد. دو مسیر واقعی:

1. کلید سراسری داخل اپ با ترکیبی آزاد (مثلاً `Ctrl+Alt+E`).
2. اگر دقیقاً `Win+E` لازم است: یا بایند Explorer را با یک remapper عوض کن، یا حالت
   Explorer-replacement را فعال کن (در نقشهٔ راه، فاز انتشار).

## انتخابگر فایل برای فایرفاکس و برنامه‌های XDG

فایرفاکس و هر برنامهٔ **پورتال‌آگاه** برای «باز کردن» و «ذخیره» فایل، دیالوگ خود را از
`xdg-desktop-portal` می‌خواهد. مکس یک بک‌اند پورتال است و می‌تواند همان دیالوگ را بدهد:

> حتی در لینوکس هم این پوشش کامل نیست: کروم/الکترونِ بومی دیالوگ GTK خودش را دارد و پورتال را
> صدا نمی‌زند (نسخهٔ فلت‌پک/اسنپ آگاه است). پس «جانشین سراسری» از اول هم فقط «جانشین برای
> برنامه‌های پورتال‌آگاه» بود.

1. پیشخوان برنامه → تنظیمات → **راه‌اندازی** → «انتخابگر فایل مکس برای برنامه‌های دیگر» را روشن کن.
2. برنامه‌های باز را یک بار ببند و باز کن (فایرفاکس تنظیمات پورتال را در آغاز می‌خواند).

این کلید چه فایل‌هایی می‌نویسد (همه در پروفایل خودت، بدون sudo):
```
~/.local/share/xdg-desktop-portal/portals/mfm.portal        # معرفی بک‌اند و اینترفیس
~/.local/share/dbus-1/services/org.freedesktop.impl.portal.desktop.mfm.service
~/.config/xdg-desktop-portal/portals.conf                   # FileChooser=mfm;gtk;
```

قواعد نگه‌داری که نباید بشکنند:

- فقط توکن `mfm` به **همان یک کلید** `org.freedesktop.impl.portal.FileChooser` اضافه/حذف می‌شود؛
  بقیهٔ کلیدها (مثل `default=kde`) و بک‌اندهای دیگر دست‌نخورده می‌مانند تا Settings/Secret/Print
  سالم بمانند. خاموش‌کردن، فایل را به همان حالت قبل برمی‌گرداند.
- ترتیب `mfm;gtk;` یعنی اگر مکس خطا داد، `xdg-desktop-portal` سراغ GTK می‌رود؛ پورتال هیچ‌وقت
  بدون دیالوگ نمی‌ماند.
- سرویس D-Bus این‌طور اجرا می‌شود: `electron <appDir> --portal-backend`. اگر برنامه باز نباشد،
  D-Bus خودش آن را بالا می‌آورد، **بدون پنجرهٔ اصلی**، فقط پنجرهٔ انتخاب فایل؛ بعد از پاسخ خارج
  می‌شود. اگر برنامه باز باشد، همان نمونهٔ باز پاسخ می‌دهد (تک‌نمونه حفظ می‌شود).
- مرز زمانی حساس است: `bus.export()` **قبل** از `requestName()` انجام می‌شود و پنجره **بعد** از ارسال
  پاسخ بسته می‌شود. برعکسش دو باگ واقعی بود: «Method OpenFile does not exist» و پاسخ خطای ۲
  به‌جای فایل انتخاب‌شده.
- **نشان‌شده‌ها (Bookmarks) مشترک‌اند**: دیالوگ همان `state.marks` را می‌خواند که سایدبار برنامه نشان
  می‌دهد و ستارهٔ نوار بالای دیالوگ هم همان لیست را عوض می‌کند (IPC `state:marks` در main، سپس
  پخش `state:marks` به همهٔ پنجره‌ها). هر دو طرف بلافاصله هم‌گام می‌شوند؛ لیست را در دو جا نگه ندار.

بررسی سلامت:

```bash
busctl --user list | grep desktop.mfm                      # نام D-Bus باید مالک داشته باشد
cat ~/.config/xdg-desktop-portal/portals.conf              # FileChooser=mfm;gtk;
gdbus call --session --dest org.freedesktop.portal.Desktop \
  --object-path /org/freedesktop/portal/desktop \
  --method org.freedesktop.portal.FileChooser.OpenFile "" "Test" '{}'
```

## ویندوز: چرا دیالوگ باز/ذخیرهٔ برنامه‌ها جانشین‌شدنی نیست

در لینوکس این کار شد چون یک **قرارداد استاندارد و مستند** وجود دارد: `org.freedesktop.impl.portal.FileChooser`
و `portals.conf`. ویندوز چنین نقطهٔ توسعه‌ای ندارد:

- `GetOpenFileNameW`/`GetSaveFileNameW` (comdlg32) و `IFileOpenDialog`/`IFileSaveDialog` **داخل پروسهٔ
  خودِ برنامه** اجرا می‌شوند؛ سیستم‌عامل دیالوگ را از یک سرویس بیرونی نمی‌گیرد.
- هیچ API، Group Policy یا کلید رجیستری‌ای برای «دیالوگ باز/ذخیرهٔ من را به برنامهٔ X بده» وجود ندارد.
  `IFileDialog::AddPlace` در اختیار خودِ برنامه است و از بیرون صدا زدنش ممکن نیست.
- پس مکس نمی‌تواند «بک‌اند دیالوگ» شود؛ معادل `mfm.portal` در ویندوز نداریم.

**تنها راه فنی: تزریق DLL و هوک.** ابزارهایی مثل FlashFolder و بخشی از Listary همین کار را می‌کنند:
یک DLL در پروسهٔ هر برنامه تزریق و `GetOpenFileNameW` / `IFileDialog::Show` هوک می‌شود. هزینه‌ها:

| هزینه | جزئیات |
| --- | --- |
| آنتی‌ویروس/EDR | تزریق حافظه به پروسهٔ دیگر، همان الگویی است که بدافزار دارد؛ SmartScreen و EDR جلو می‌گیرند و نصب‌کننده باید EV-امضا شود. |
| نگه‌داری | باینری جدا برای x86/x64، رفتار متفاوت هر نسخهٔ ویندوز، و تست per-app برای هر برنامه‌ای که کاربر دارد. |
| پوشش ناقص | Store/UWP، Office Protected View، کروم/الکترون و Adobe دیالوگ اختصاصی دارند یا محافظت‌شده‌اند؛ هوک آنجا کار نمی‌کند. |
| ریسک | یک باگ در هوک = کرش برنامهٔ میزبان، و کاربر تقصیر مکس می‌نویسد. |

**تصمیم: پیاده نمی‌شود.** این مسیر با قواعد امنیتی همین مخزن (بدون تزریق کد، بدون سطح ممتاز،
ممیزی پاک) در تضاد است و «جانشین دیالوگ» سراسری هم از آن درنمی‌آید. دوباره سراغش نرو.

چیزهایی که در عوض در ویندوز کار می‌کنند:

1. **مدیر فایل پیش‌فرض پوشه‌ها** (بخش بعد): هر برنامه‌ای که `ShellExecute` روی پوشه بزند، مکس را باز می‌کند.
2. **«باز کردن با» و دستورهای سفارشی**: همان‌ها که هر برنامه‌ای از شل می‌پرسد.
3. **میان‌بر در نوار کنارِ خودِ دیالوگ‌ها** (ممکن، ولی پیاده **نشده**): هر میان‌بری که در
   `%APPDATA%\Microsoft\Windows\Network Shortcuts` گذاشته شود، در همهٔ دیالوگ‌های استاندارد باز/ذخیره
   زیر «Network» دیده می‌شود (اکسپلورر و comdlg32 هر دو از همان شل‌نیزم‌اسپیس می‌خوانند). این
   دیالوگ را جایگزین نمی‌کند، فقط مکس و نشان‌ها را از داخل هر برنامه یک کلیک دور می‌کند. رفتار شل
   است و مستند رسمی نیست؛ اگر روزی اضافه شد باید یک گزینهٔ روشن/خاموش و پاک‌سازی کامل `.lnk`ها داشته باشد.

## بررسی سلامت فایل `.desktop`

```bash
xdg-mime query default inode/directory        # باید max-file-manager.desktop باشد
grep -E '^(Exec|MimeType|Icon)=' ~/.local/share/applications/max-file-manager.desktop
```

## ویندوز: باز شدن پوشه‌ها در مکس

تنظیمات → راه‌اندازی → «مدیر فایل پیش‌فرض سیستم» → «تنظیم به عنوان پیش‌فرض». این کار فقط
کلیدهای **کاربر** (HKCU) را می‌نویسد و نیازی به ادمین ندارد:

```
HKCU\Software\Classes\Directory\shell\MaxFileManager\command  = "<app.exe>" "%1"
HKCU\Software\Classes\Directory\shell                          (default) = MaxFileManager
همین دو کلید برای Drive هم نوشته می‌شوند — و فقط همین دو
```

نتیجه: دابل‌کلیک روی پوشه در دسکتاپ یا هر برنامه‌ای که `ShellExecute` می‌زند (Open Containing
Folder مرورگرها، Start menu، drag-to-open) مکس را باز می‌کند. پنجرهٔ خود Explorer همچنان داخل
خودش ناوبری می‌کند — این رفتار Explorer است و با verb رجیستری عوض نمی‌شود.

بررسی و بازگرداندن:

```powershell
reg query "HKCU\Software\Classes\Folder\shell" /ve
reg query "HKCU\Software\Classes\Folder\shell\MaxFileManager\command" /ve
```

دکمهٔ «بازگرداندن به ویندوز» همان تنظیمات، کلیدهای `MaxFileManager` را حذف می‌کند و مقدار
پیش‌فرض قبلی هر کلاس را از store برمی‌گرداند (مسیر `%APPDATA%\max-file-manager\search.db`،
کلید `windows-shell`). اگر مقدار قبلی `none` یا خالی بود — یعنی همان حالتِ خرابیِ
«Application not found» که بعضی ابزارهای tweak می‌سازند — به‌جای آن یک verb سالم Explorer در
HKCU نوشته می‌شود، نه همان مقدار خراب.

### فقط پوشه‌های واقعی: کلاس‌ها و لینک‌های کنترل پنل

verb فقط روی **`Directory`** (پوشهٔ فایل‌سیستمی) و **`Drive`** (درایو) نوشته می‌شود. `Folder` عمداً
دست‌نخورده می‌ماند، چون کلاس پایهٔ همهٔ شل‌نیزم‌اسپیس‌هاست: Control Panel، This PC، Recycle Bin و
پوشهٔ اپ‌های Store. تا وقتی `Folder` هم ثبت بود، ویندوز کلیک Control Panel را هم به مکس می‌داد و
مکس را با یک مسیر شل‌نیزم‌اسپیس صدا می‌زد، نه با مسیر پوشه:

```
"Max File Manager.exe" "::{26EE0668-A00A-44D7-9371-BEB064C98683}"
```

نتیجه این بود که Control Panel باز نمی‌شد. حالا فقط پوشه‌های واقعی به مکس می‌آیند و پوشه‌های ویژه
همان‌طور در Explorer باز می‌شوند. بیلدهای قدیمی‌تر `Folder` را هم می‌نوشتند، پس
`migrateWindowsShellRegistration()` هنگام بالا آمدن همان verb را — فقط اگر هنوز مال ما باشد —
برمی‌دارد و verb سیستمی `open` را برمی‌گرداند؛ کاربر لازم نیست تنظیم را دو بار دست بزند.

دو نکتهٔ فنی که در همین مسیر اندازه‌گیری شد:

- **`explorer.exe ::{CLSID}` پنجرهٔ دیده‌نشده می‌سازد.** به‌عنوان تور نجات، `openTarget` در
  `src/main/launch-path.ts` هدف‌های `::{}`/`shell:` را `kind: 'shell'` تشخیص می‌دهد و
  `openShellNamespace` در `src/main/desktop.ts` آن‌ها را با `explorer.exe /n,<target>` باز می‌کند.
  با شکل ساده (بدون `/n,`) شش پنجرهٔ پنهان Control Panel در explorer.exe ساخته شد و هیچ پنجرهٔ
  دیده‌شدنی نه — یعنی «هیچ اتفاقی نمی‌افتد».
- **`shell.openPath`/`ShellExecute` این‌جا جواب نمی‌دهد:** با verb خودمان به خودمان برمی‌گردد (حلقه).
  فقط `explorer.exe` است که شل خودش بازش می‌کند.

دکمهٔ **Control Panel** در هدر برنامه (فقط ویندوز، کنار تنظیمات) همان مسیر را صدا می‌زند
(`desktop:openControlPanel`).

بررسی: با روشن بودن «مدیر فایل پیش‌فرض سیستم» (تنظیمات → راه‌اندازی) دابل‌کلیک روی یک پوشه باید
مکس را باز کند و از Win+R مسیر `::{26EE0668-A00A-44D7-9371-BEB064C98683}` باید پنجرهٔ Control Panel
بیاید، بدون هیچ پنجرهٔ مکس.

## ویندوز: Win+E وقتی برنامه بسته است

هوک صفحه‌کلید (`WinEHook.exe`) با گزینهٔ «Win+E وقتی برنامه بسته است هم کار کند»
(تنظیمات → راه‌اندازی، پیش‌فرض روشن) بدون `--parent` اجرا می‌شود و این مقدار در Run کاربر
نوشته می‌شود:

```
HKCU\Software\Microsoft\Windows\CurrentVersion\Run\MaxFileManagerWinE
  = "<install>\resources\WinEHook.exe" --target "<install>\Max File Manager.exe"
```

با خاموش‌کردن گزینهٔ Win+E، مقدار Run پاک و هر نمونهٔ `WinEHook.exe` بسته می‌شود.ت

بررسی سریع:

```powershell
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v MaxFileManagerWinE
Get-Process WinEHook -ErrorAction SilentlyContinue
```
