# ContextVault installation guide | دليل تثبيت ContextVault

> **Development preview.** Install ContextVault **from source only**. There is no published npm package, hosted build, or installer. | **نسخة تطويرية.** ثبّت ContextVault **من المصدر فقط**. لا توجد حزمة npm أو نسخة مستضافة أو أداة تثبيت منشورة.

All commands use generic placeholders such as `C:/Projects/ExampleWorkspace`. Replace them with paths on your own machine. | جميع الأوامر تستخدم مسارات عامة. استبدلها بمسارات جهازك.

---

## 1. Prerequisites | المتطلبات

| Requirement       | Details                                                                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operating system  | Windows 10/11 (filesystem authorization verified on Windows); macOS and Linux commands are provided but platform-specific guarantees are not verified there |
| Node.js           | **24.0.0 or newer** — the server fails closed and refuses to start on older runtimes                                                                        |
| pnpm              | **11.19.0** (the version pinned in `packageManager`)                                                                                                        |
| Git               | Any recent version, for cloning the source repository                                                                                                       |
| Repository access | Authorized access to this private repository; use Git Credential Manager or an SSH key for cloning                                                          |

### 1.1 Confirm versions | التأكد من الإصدارات

```powershell
node --version    # expect v24.x or newer
pnpm --version    # expect 11.19.0
git --version
```

### 1.2 Enable pnpm via Corepack | تفعيل pnpm عبر Corepack

```powershell
corepack enable
corepack prepare pnpm@11.19.0 --activate
```

Use an equivalent trusted installation if Corepack is unavailable in your environment. Do not download installers from unofficial mirrors. | استخدم تثبيتًا موثوقًا مكافئًا عند تعذر Corepack، ولا تنزّل من مرايا غير رسمية.

### 1.3 Access the source repository | الوصول إلى مستودع المصدر

The repository currently requires authorized access. Use Git Credential Manager or an SSH key for cloning; do not put credentials in the URL. | يتطلب المستودع حاليًا وصولًا مصرّحًا به. استخدم Git Credential Manager أو مفتاح SSH للنسخ، ولا تضع بيانات الاعتماد داخل الرابط.

```powershell
git clone https://github.com/D0shi-Eng/Context_Vault.git ContextVault
cd ContextVault
```

- **Windows:** Git Credential Manager (shipped with Git for Windows) prompts in a browser on the first authenticated operation.
- **macOS/Linux:** use an HTTPS credential or SSH key configured for your account.

If an authenticated operation fails with `Authentication failed`, confirm your account has the required permission and that your credential helper is configured. Never paste tokens into chat, issues, or logs. | إذا فشلت عملية تتطلب مصادقة بخطأ `Authentication failed` فتأكد من امتلاك حسابك الصلاحية اللازمة ومن ضبط مساعد بيانات الاعتماد. ولا تلصق الرموز في المحادثات أو المشكلات أو السجلات.

---

## 2. Windows installation (PowerShell) | التثبيت على ويندوز

### 2.1 Clone | النسخ

```powershell
git clone https://github.com/D0shi-Eng/Context_Vault.git ContextVault
cd ContextVault
```

### 2.2 Install with a frozen lockfile | التثبيت بقفل مجمّد

```powershell
pnpm install --frozen-lockfile
```

`--frozen-lockfile` installs exactly the versions in `pnpm-lock.yaml` and fails if the lockfile and `package.json` disagree. This is intentional. | يثبّت الإصدارات المطابقة تمامًا لملف القفل ويفشل عند الاختلاف، وهذا مقصود.

### 2.3 Build | البناء

```powershell
pnpm run build
```

Strict TypeScript build (`tsc -p tsconfig.build.json`) producing ESM output in `dist/`. The server entrypoint is `dist/main.js`. | بناء صارم ينتج `dist/` ونقطة الدخول `dist/main.js`.

### 2.4 Run local verification | التحقق المحلي

```powershell
pnpm run check
```

This chains formatting, lint, typecheck, architecture rules, schema validation, secret scan, full tests with coverage, and the production build. | ينفذ التنسيق والفحص الساكن والأنواع والمعمارية والمخططات والأسرار والاختبارات مع التغطية ثم البناء.

### 2.5 Run the server | تشغيل الخادم

```powershell
node dist/main.js --workspace-root=demo=C:/Projects/ExampleWorkspace
```

- Format: `--workspace-root=<root-id>=<absolute-path-to-directory>`, repeatable for multiple roots.
- `<root-id>` matches `/^[a-z][a-z0-9_-]{0,63}$/`; duplicates are rejected.
- The path must be absolute, existing, and a directory; filesystem roots (`/`, `C:\`) are refused.
- Zero roots is valid: the server starts and every read fails closed with `CV_AUTHORIZATION_DENIED`.
- The server speaks MCP over local `stdio` only. No ports are opened.

---

## 3. macOS / Linux installation | التثبيت على ماك/لينكس

```bash
git clone https://github.com/D0shi-Eng/Context_Vault.git ContextVault
cd ContextVault
corepack enable
corepack prepare pnpm@11.19.0 --activate
pnpm install --frozen-lockfile
pnpm run build
node dist/main.js --workspace-root=demo=/absolute/path/to/a/workspace/folder
```

**Caveat:** filesystem authorization guarantees (canonicalization, case folding, reparse handling) are verified on Windows only. Do not treat other kernels as security-verified. | **تحذير:** ضمانات نظام الملفات مُتحقق منها على ويندوز فقط.

---

## 4. Verification steps | خطوات التحقق

Each command must exit zero. | كل أمر يجب أن يخرج بصفر.

| Step         | Command                       | Purpose                            |
| ------------ | ----------------------------- | ---------------------------------- |
| Formatting   | `pnpm run format:check`       | Prettier consistency               | التنسيق      |
| Lint         | `pnpm run lint`               | ESLint, zero warnings              | الفحص الساكن |
| Typecheck    | `pnpm run typecheck`          | Full project type check            | الأنواع      |
| Architecture | `pnpm run check:architecture` | Layer dependency rules             | المعمارية    |
| Schemas      | `pnpm run validate:schemas`   | JSON Schema validation             | المخططات     |
| Secret scan  | `pnpm run check:secrets`      | High-confidence secret signatures  | الأسرار      |
| Tests        | `pnpm test`                   | Full Vitest suite                  | الاختبارات   |
| Coverage     | `pnpm run test:coverage`      | Coverage thresholds                | التغطية      |
| Build        | `pnpm run build`              | Strict production build in `dist/` | البناء       |

`pnpm run check` runs all of the above in one command. | ينفذ كل ما سبق بأمر واحد.

---

## 5. Confirm the connection works | التأكد من عمل الاتصال

1. Point your MCP client at the built entrypoint (see [INTEGRATION.md](INTEGRATION.md)) and restart the client.
2. The tool list must show exactly six tools: `contextvault_inspect`, `contextvault_prepare`, `contextvault_retrieve`, `contextvault_verify`, `contextvault_stats`, `contextvault_purge`.
3. Call `contextvault_inspect` for a file inside an authorized root → expect content-free metadata and no file content.
4. Call it with an undeclared `rootId` → expect `CV_AUTHORIZATION_DENIED` with a correlation id and nothing else.
5. Run the safe cycle once (inspect → prepare → verify → purge) and confirm `contextvault_stats` counters move accordingly.

---

## 6. Calling the six tools | استدعاء الأدوات الست

- `contextvault_inspect`: `{ "source": { "kind": "workspace_file", "rootId": "demo", "path": "docs/notes.md" } }`.
- `contextvault_prepare`: same `source`, plus optional narrow `retrieval: { "allowedSelectorTypes": ["line_range"], "maxBytes": 4096 }` and `ttlSeconds` (60–7200).
- `contextvault_retrieve`: `{ "capability": "<from-prepare>", "selector": { "kind": "line_range", "startLine": 1, "endLine": 40 } }`. Content-revealing by design.
- `contextvault_verify`: `{ "envelopeId": "<from-prepare>", "checks": [{ "kind": "source_freshness" }] }` (max 16 checks).
- `contextvault_stats`: `{}`.
- `contextvault_purge`: `preview` with a `target` first, then `execute` with the returned `purgeIntentId`.

Purge removes ContextVault-owned in-memory derived state only; original files are never touched. | تمحو أداة التنظيف الحالة المشتقة التي يحتفظ بها ContextVault في الذاكرة فقط، ولا تمس الملفات الأصلية.

## 7. Installing the Skill | تثبيت المهارة

Copy the `skills/contextvault/` directory from this checkout into your agent client's skills directory, or reference its path from the client configuration. No build step is needed. Usage follows the Skill: retrieve only on explicit need, re-verify after reading, purge at task end. | انسخ مجلد `skills/contextvault/` إلى مجلد مهارات عميلك، أو أشِر إلى مساره من إعدادات العميل. لا يلزم تشغيل خطوة بناء. اتبع سير عمل المهارة: لا تسترجع المحتوى إلا عند الحاجة الصريحة، وأعد التحقق بعد القراءة، ثم امحُ حالة الجلسة عند انتهاء المهمة.

## 8. Updating locally | التحديث محليًا

```powershell
git pull
pnpm install --frozen-lockfile
pnpm run build
pnpm run check
```

Then re-copy `skills/contextvault/` to your client skills directory. | ثم أعِد نسخ مجلد المهارة.

---

## 9. Troubleshooting | استكشاف الأخطاء وإصلاحها

### 9.1 Node version too old | إصدار Node قديم

The process exits at startup with a runtime-guard error. Fix: install Node.js 24+ and confirm `node --version`. The server deliberately fails closed on older runtimes. | ثبّت Node 24+.

### 9.2 pnpm unavailable | غياب pnpm

Re-run `corepack prepare pnpm@11.19.0 --activate`, or install pnpm through your platform's trusted package manager. | أعد التفعيل أو ثبّت عبر مدير حزم موثوق.

### 9.3 Frozen-lockfile failure | فشل القفل المجمّد

Lockfile/manifest mismatch. Do not edit `pnpm-lock.yaml` by hand; check out the matching commit. | لا تعدّل ملف القفل يدويًا.

### 9.4 Incorrect absolute path | مسار غير مطلق

`--workspace-root` requires an absolute path to an existing directory. Relative paths, files, and filesystem roots are rejected at startup. | يستلزم مسارًا مطلقًا لمجلد موجود.

### 9.5 UNC and network share roots | جذور UNC والمجلدات الشبكية

A workspace root may be a UNC path (`\\server\share\folder`). It is accepted at startup only when it is absolute, resolves through `realpath` to an existing directory, and is not a filesystem or share root by itself. Startup canonicalization is the trust anchor: client paths are always relative and can never name a UNC or absolute location. Security constraints: a remote share is trusted infrastructure — its availability, contents, and link behavior are outside ContextVault's control; reparse points and traversal remain denied beneath the root; and latency or outage of the share surfaces as read failures, not fallbacks. | يُقبل جذر UNC (`\\server\share\folder`) عند بدء التشغيل فقط إذا كان مسارًا مطلقًا ويُحل عبر `realpath` إلى مجلد موجود وليس جذرًا بذاته. مسارات العميل نسبية دائمًا ولا يمكنها تسمية موقع UNC أو مطلق أبدًا. قيود أمنية: المجلد الشبكي بنية تحتية موثوقة توثقها أنت — التوفر والمحتوى وسلوك الروابط خارج نطاق ContextVault؛ ويبقى رفض نقاط إعادة التوجيه والخروج من الجذر مطبقًا تحت الجذر؛ وينعكس انقطاع المجلد كفشل قراءة لا كتراجع.

### 9.6 Unknown workspace root | جذر مجهول

`CV_AUTHORIZATION_DENIED` means the `rootId` was not declared at startup. Roots are startup-only; there is no runtime registration. | الجذور عند بدء التشغيل فقط.

### 9.7 Windows path quoting | اقتباس مسارات ويندوز

In JSON configuration, escape backslashes (`C:\\Projects\\…`) or use forward slashes (`C:/Projects/…`). In PowerShell, quote paths containing spaces. | ضاعف الشرطات الخلفية داخل JSON أو استخدم الأمامية.

### 9.8 MCP process exits immediately | خروج العملية فورًا

Check: (a) `dist/main.js` exists (run `pnpm run build`), (b) the client path is absolute, (c) Node 24 is the default runtime. | تحقق من البناء والمسار المطلق وإصدار Node.

### 9.9 Why no file content is returned | لماذا لا يعود محتوى الملف

By design. Inspect and prepare are content-free; only `contextvault_retrieve` with an explicit capability returns exact bounded excerpts. | مقصود: الفحص والتحضير خاليان من المحتوى، والاسترجاع وحده يعيد مقتطفات محدودة مع قدرة صريحة.

### 9.10 Why network transport is unavailable | لماذا لا يوجد نقل شبكي

Local `stdio` is the only transport; a network listener is not implemented and is prohibited. | `stdio` المحلي هو القناة الوحيدة، ومستمع الشبكة غير مطبق ومحظور.
