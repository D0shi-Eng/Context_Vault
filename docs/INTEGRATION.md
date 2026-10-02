# ContextVault MCP integration guide | دليل الربط مع MCP

> **Development preview.** This guide connects a **local MCP client** to a **source build** of ContextVault over local `stdio`. ContextVault never modifies client configuration automatically. | **نسخة تطويرية.** يربط هذا الدليل عميل MCP محليًا ببناء من المصدر عبر `stdio`. لا يعدّل ContextVault إعدادات العميل تلقائيًا.

---

## 1. English

### 1.1 What an MCP stdio server is

The Model Context Protocol lets a client (an IDE, an agent, a CLI) talk to servers over a transport. With the **stdio transport**, the client starts the server as a child process and exchanges JSON-RPC messages over its standard input and output. No port is opened, no network is involved, and the server lives only as long as the client session.

### 1.2 Why ContextVault is local stdio only

ContextVault works with files inside explicitly authorized workspace roots — an inherently local operation. The only transport is **local `stdio`**. A network listener is not implemented and is prohibited; there is no HTTP, SSE, or WebSocket transport.

### 1.3 Build before connecting

Clients do not compile TypeScript. Build first, then point the client at the built entrypoint:

```powershell
pnpm install --frozen-lockfile
pnpm run build
```

The built entrypoint is `<clone-root>/dist/main.js`. If the file does not exist, the client spawns a process that exits immediately.

### 1.4 Identify the absolute path to `dist/main.js`

Use the absolute path of your own checkout. Shape examples only:

```text
/absolute/path/to/ContextVault/dist/main.js          (macOS/Linux)
/absolute/path/to/ContextVault/dist/main.js          (Windows, forward slashes)
C:\\absolute\\path\\to\\ContextVault\\dist\\main.js  (Windows, escaped backslashes)
```

From PowerShell:

```powershell
Resolve-Path .\dist\main.js
```

### 1.5 Declare one authorized workspace root

Repeatable startup arguments of the form:

```text
--workspace-root=<root-id>=<absolute-path-to-directory>
```

`<root-id>` must match `/^[a-z][a-z0-9_-]{0,63}$/`. The path must be an **absolute path to an existing directory**:

```text
--workspace-root=demo=C:/Projects/ExampleWorkspace
```

### 1.6 Declare multiple roots

Repeat the argument once per root:

```text
--workspace-root=alpha=C:/Projects/Alpha
--workspace-root=beta=C:/Projects/Beta
```

Duplicate root ids are rejected. Each root is canonicalized once at startup; a root that canonicalizes to a filesystem root (`/`, `C:\`) is refused. Zero roots is valid and deny-by-default.

### 1.7 Generic MCP JSON configuration

Most MCP clients expose a JSON server list (the exact file location depends on the client). A generic, client-neutral shape built on the real CLI:

```json
{
  "mcpServers": {
    "contextvault": {
      "command": "node",
      "args": [
        "C:/Projects/ContextVault/dist/main.js",
        "--workspace-root=project=C:/Projects/ExampleWorkspace"
      ]
    }
  }
}
```

Multiple roots add more `--workspace-root=…` entries to `args`.

### 1.8 Windows JSON path escaping

Inside JSON strings, double backslashes or use forward slashes:

```json
{
  "mcpServers": {
    "contextvault": {
      "command": "node",
      "args": [
        "C:/Projects/ContextVault/dist/main.js",
        "--workspace-root=project=C:/Projects/ExampleWorkspace"
      ]
    }
  }
}
```

### 1.9 macOS / Linux path examples

```json
{
  "mcpServers": {
    "contextvault": {
      "command": "node",
      "args": [
        "/home/user/dev/ContextVault/dist/main.js",
        "--workspace-root=project=/home/user/dev/authorized/project"
      ]
    }
  }
}
```

### 1.10 Restart the MCP client

Clients read server configuration at startup. After editing the configuration, fully restart the client so it respawns ContextVault with the new arguments.

### 1.11 Confirm the six tools appear

After restart, open the client's tool list. Exactly six tools must be listed:

```text
contextvault_inspect
contextvault_prepare
contextvault_retrieve
contextvault_verify
contextvault_stats
contextvault_purge
```

If the list differs, the client is not running this build — check the configured absolute path and rebuild.

### 1.12 Test an authorized file (inspect)

```json
{
  "source": {
    "kind": "workspace_file",
    "rootId": "project",
    "path": "docs/notes.md"
  }
}
```

Expect content-free metadata (`sourceId`, `sourceDigest`, `mediaType`, `bytes`, `sensitivity`, `secretRisk`, `supportedSelectors`, `inspectedAt`) and **no file content**.

### 1.13 Prepare, retrieve, verify (explicit need only)

Prepare the same source with a narrow grant, retrieve one bounded slice, then verify before quoting:

```json
{
  "source": { "kind": "workspace_file", "rootId": "project", "path": "docs/notes.md" },
  "retrieval": { "allowedSelectorTypes": ["line_range"], "maxBytes": 4096 }
}
```

```json
{
  "capability": "<capability-from-prepare>",
  "selector": { "kind": "line_range", "startLine": 1, "endLine": 40 }
}
```

```json
{ "envelopeId": "<envelope-id-from-prepare>", "checks": [{ "kind": "source_freshness" }] }
```

Retrieval is content-revealing by design. Stats takes `{}`; purge needs `preview` with a target before `execute` with the returned intent id.

### 1.14 Test an unknown root (fail closed)

```json
{
  "source": {
    "kind": "workspace_file",
    "rootId": "missing-root",
    "path": "any.txt"
  }
}
```

Expect a generic content-free error envelope with `code: "CV_AUTHORIZATION_DENIED"`, a correlation identifier, and no source content, no local path, and no raw operating-system error.

### 1.15 Response fields

| Field                            | Meaning                                              |
| -------------------------------- | ---------------------------------------------------- |
| `sourceId` / `envelopeId`        | Stable opaque identifiers                            |
| `sourceDigest` / `excerptDigest` | `sha256:…` digests                                   |
| `mediaType` / `bytes`            | Conservative type guess and file size                |
| `sensitivity` / `secretRisk`     | Conservative classification (values never disclosed) |
| `supportedSelectors`             | Selector kinds available for this source             |
| `truncated` / `hasMore`          | Bounded-output markers on retrieval                  |
| `correlationId`                  | Identifier on every response, success or failure     |

### 1.16 Security implications of authorizing a root

Declaring a root grants the ContextVault process **read** access to everything beneath it (subject to containment and fail-closed rules). Authorize the narrowest directory that satisfies the task, and remember that retrieval with a capability discloses exact slices by design.

### 1.17 How to narrow permissions

- Prefer one deep subdirectory over an entire project tree.
- Never authorize a filesystem root (`/`, `C:\`) — startup refuses it.
- Keep TTLs short, selector allowlists narrow, and `maxBytes` small.

### 1.18 How to remove a root

Delete its `--workspace-root=…` entry and restart the client. There is no runtime un-registration. At session end, purge derived state (`preview`, then `execute`) — memory also clears on process exit.

### 1.19 Common connection errors

| Symptom                              | Cause and fix                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| Client shows no tools                | `dist/main.js` missing (build first), wrong absolute path, or spawn failure   |
| Process exits immediately            | Node older than 24; check `node --version`                                    |
| `CV_AUTHORIZATION_DENIED` everywhere | Zero roots declared, or the `rootId` was not declared at startup              |
| `CV_PATH_OUTSIDE_WORKSPACE`          | Escaping relative path (`..` segments)                                        |
| `CV_PATH_REPARSE_POINT_DENIED`       | Symlink or junction traversal; denied by design                               |
| `CV_RESOURCE_SOURCE_TOO_LARGE`       | File exceeds the source ceiling; denied by design                             |
| `CV_CAPABILITY_INVALID`              | Unknown, expired, revoked, or mismatched capability; prepare a fresh envelope |
| `CV_SOURCE_CHANGED` / `stale`        | Source changed after preparation; re-inspect and re-prepare                   |
| Purge execute rejected               | Missing `purgeIntentId` from a prior `preview`                                |
| JSON errors in the client            | Windows backslash escaping; see 1.8                                           |
| Unexpected tool list                 | Not running this build; check the configured path                             |

Client-specific configuration file locations are **not documented here** because they were not verified against current official client documentation; consult your client's official docs. This guide stays client-neutral.

---

## 2. العربية

### 2.1 ما هو خادم MCP عبر stdio؟

يتيح بروتوكول سياق النموذج (MCP) للعميل (بيئة تطوير أو وكيل أو CLI) التخاطب مع الخوادم عبر قناة نقل. مع **stdio المحلية** يشغّل العميل الخادم كعملية ابنة ويتبادل معه رسائل JSON-RPC عبر المدخلات والمخرجات القياسية. لا يُفتح أي منفذ ولا تدخل الشبكة، وتنتهي العملية بانتهاء جلسة العميل.

### 2.2 لماذا ContextVault محلي عبر stdio فقط؟

يعمل ContextVault على ملفات داخل جذور عمل مصرّح بها صراحةً — وهي عملية محلية بطبيعتها. القناة الوحيدة هي **stdio المحلية**. مستمع الشبكة غير مطبق ومحظور؛ ولا يوجد HTTP أو SSE أو WebSocket.

### 2.3 البناء قبل الربط

العميل لا يجمّع TypeScript؛ ابنِ أولًا ثم وجّه العميل إلى ملف البناء:

```powershell
pnpm install --frozen-lockfile
pnpm run build
```

نقطة الدخول المبنية: `<جذر-النسخ>/dist/main.js`. إن لم يوجد الملف فستبدأ العملية وتخرج فورًا.

### 2.4 تحديد المسار المطلق لـ dist/main.js

```powershell
Resolve-Path .\dist\main.js
```

### 2.5 تعريف جذر عمل واحد

```text
--workspace-root=<معرّف-الجذر>=<مسار-مطلق-لمجلد>
```

- `<معرّف-الجذر>` يطابق `/^[a-z][a-z0-9_-]{0,63}$/`.
- المسار **مطلق** وموجود ومجلد.
- مثال: `--workspace-root=project=C:/Projects/ExampleWorkspace`

### 2.6 تعريف عدة جذور

كرر الوسيط مرة لكل جذر. كل جذر يُوحَّد مرة واحدة عند بدء التشغيل، ويُرفض ما يوحَّد إلى جذر نظام ملفات مثل `/` أو `C:\`. وعدم تعريف أي جذر صالح وهو وضع رفض افتراضي.

### 2.7 الإعداد العام لعميل MCP

```json
{
  "mcpServers": {
    "contextvault": {
      "command": "node",
      "args": [
        "C:/Projects/ContextVault/dist/main.js",
        "--workspace-root=project=C:/Projects/ExampleWorkspace"
      ]
    }
  }
}
```

### 2.8 الهروب في مسارات ويندوز داخل JSON

ضاعف الشرطات الخلفية أو استخدم الأمامية (`C:/Projects/…`).

### 2.9 إعادة تشغيل العميل

يقرأ العميل إعدادات الخوادم عند بدئه؛ أعد تشغيله بالكامل بعد التعديل حتى يولّد عملية ContextVault من جديد.

### 2.10 التأكد من ظهور الأدوات الست

```text
contextvault_inspect
contextvault_prepare
contextvault_retrieve
contextvault_verify
contextvault_stats
contextvault_purge
```

إن اختلفت القائمة فأنت لا تشغّل هذا البناء — راجع المسار المطلق وأعِد البناء.

### 2.11 اختبار ملف مصرّح به (فحص)

```json
{
  "source": {
    "kind": "workspace_file",
    "rootId": "project",
    "path": "docs/notes.md"
  }
}
```

المتوقع: بيانات وصفية خالية من المحتوى **دون أي محتوى ملف**.

### 2.12 التحضير والاسترجاع والتحقق (عند الحاجة الصريحة فقط)

أنشئ منحة محدودة الصلاحيات، واسترجع مقطعًا واحدًا محدودًا، ثم تحقّق منه قبل الاقتباس. أداة الاسترجاع تكشف المحتوى بطبيعتها. تستقبل أداة الإحصاءات `{}`، أما محو الحالة فيتطلب أولًا `preview` بنطاق محدد، ثم `execute` باستخدام معرّف النية المُعاد.

### 2.13 اختبار جذر مجهول (فشل مغلق)

```json
{
  "source": {
    "kind": "workspace_file",
    "rootId": "missing-root",
    "path": "any.txt"
  }
}
```

المتوقع: غلاف خطأ عام `CV_AUTHORIZATION_DENIED` مع معرف ارتباط، دون محتوى المصدر ودون المسار المحلي ودون خطأ نظام تشغيل خام.

### 2.14 حقول الاستجابة

| الحقل                           | المعنى                              |
| ------------------------------- | ----------------------------------- |
| `sourceId` و`envelopeId`        | معرفات غير شفافة مستقرة             |
| `sourceDigest` و`excerptDigest` | بصمات `sha256:…`                    |
| `mediaType` و`bytes`            | تخمين محافظ للنوع وحجم الملف        |
| `sensitivity` و`secretRisk`     | تصنيف متحفظ (القيم لا تُكشَف أبدًا) |
| `supportedSelectors`            | أنواع المحددات المتاحة للمصدر       |
| `truncated` و`hasMore`          | علامتا الإخراج المحدود في الاسترجاع |
| `correlationId`                 | معرف في كل استجابة نجاحًا أو فشلًا  |

### 2.15 دلالات التصريح بجذر

تعريف جذر عمل يمنح العملية صلاحية **قراءة** لما بداخله (ضمن احتواء صارم ورفض آمن). صرّح بأضيق مجلد يحقق المهمة، وتذكر أن الاسترجاع مع قدرة يكشف مقاطع دقيقة بطبيعته.

### 2.16 كيف تضيّق الصلاحيات

- صرّح بمجلد فرعي عميق بدل شجرة المشروع كاملة حين يمكن.
- لا تصرّح بجذر نظام ملفات أبدًا — يُرفَض عند بدء التشغيل.
- أبقِ البقاء قصيرًا وقوائم المحددات ضيقة و`maxBytes` صغيرًا.

### 2.17 كيف تحذف جذرًا

احذف مدخله `--workspace-root=…` وأعِد تشغيل العميل. لا يوجد إلغاء تعريف وقت التشغيل. وفي نهاية الجلسة أخلِ الحالة المشتقة (`preview` ثم `execute`) — والذاكرة تُمسَح بخروج العملية أيضًا.

### 2.18 أخطاء الربط الشائعة

| العرَض                              | السبب والإصلاح                                                   |
| ----------------------------------- | ---------------------------------------------------------------- |
| العميل لا يعرض أي أدوات             | `dist/main.js` غير موجود (ابنِ) أو مسار غير مطلق أو فشل توليد    |
| العملية تخرج فورًا                  | Node أقدم من 24؛ راجع `node --version`                           |
| `CV_AUTHORIZATION_DENIED` في كل طلب | لا جذور معلنة أو `rootId` غير معلن عند بدء التشغيل               |
| `CV_PATH_OUTSIDE_WORKSPACE`         | مسار نسبي هارب (مقاطع `..`)                                      |
| `CV_PATH_REPARSE_POINT_DENIED`      | عبور رابط رمزي أو وصلة؛ الرفض مقصود                              |
| `CV_RESOURCE_SOURCE_TOO_LARGE`      | الملف يتجاوز سقف المصدر؛ الرفض مقصود                             |
| `CV_CAPABILITY_INVALID`             | قدرة مجهولة أو منتهية أو مبطلة أو غير مطابقة؛ حضّر مغلفًا جديدًا |
| `CV_SOURCE_CHANGED` أو `stale`      | تغيّر المصدر بعد التحضير؛ أعِد الفحص والتحضير                    |
| رفض تنفيذ محو الحالة                | غياب `purgeIntentId` الصادر عن عملية `preview` سابقة             |
| أخطاء JSON في العميل                | الهروب في شرطات ويندوز (القسم 2.8)                               |
| قائمة أدوات غير متوقعة              | أنت لا تشغّل هذا البناء؛ راجع المسار المُعَد                     |

مواقع ملفات إعداد العملاء المحددة غير موثقة هنا لأنها لم تُتحقق مقابل التوثيق الرسمي الحالي للعملاء؛ راجع توثيق عميلك الرسمي. هذا الدليل محايد تجاه العميل.
