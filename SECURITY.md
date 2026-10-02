# Security Policy

> **سياسة الأمان — Security Policy**

## Project status — حالة المشروع

ContextVault is a **development preview**. No version is supported for production use, and the project must not be used with sensitive or production data.

ContextVault **نسخة تطويرية**. لا يوجد إصدار مدعوم للاستخدام الإنتاجي، ويجب عدم استخدامه مع بيانات حساسة أو إنتاجية.

### Implemented security boundary — حدود الأمان المطبقة

- Local MCP over `stdio` only. No network listener, no remote telemetry, no external APIs. / تشغيل محلي عبر `stdio` فقط، دون مستمع شبكي أو قياس بعيد.
- Exactly six strict tools: `contextvault_inspect` (content-free metadata), `contextvault_prepare` (bounded structural envelopes, content-free), `contextvault_retrieve` (exact bounded excerpts, capability-gated, content-revealing by design), `contextvault_verify` (deterministic integrity checks), `contextvault_stats` (exact counters), `contextvault_purge` (two-step derived-state deletion). / ست أدوات صارمة بالضبط كما هو موصوف.
- Workspace roots are authorized explicitly at process startup; with zero roots every read fails closed with `CV_AUTHORIZATION_DENIED`. / تُصرَّح جذور العمل صراحةً عند بدء التشغيل، وبعدم تعريف أي جذر تفشل كل قراءة بشكل مغلق.
- Derived state lives in process-scoped memory only, with TTL and hard ceilings. No database, no persistence beyond process memory. / الحالة المشتقة في ذاكرة نطاق العملية فقط مع انتهاء صلاحية وأسقف صارمة. لا قاعدة بيانات ولا تخزين يتجاوز ذاكرة العملية.
- Classification is heuristic and conservative; matched secret values are never returned or logged. / التصنيف إرشادي ومتحفظ؛ والقيم المطابقة لا تُعاد ولا تُسجَّل أبدًا.

## Reporting a vulnerability — الإبلاغ عن ثغرة

Repository access is currently restricted. Authorized collaborators can
report suspected vulnerabilities in a private repository issue; avoid
posting credentials, source excerpts, or exploit details outside the
restricted repository. If public access is enabled later, GitHub private
vulnerability reporting must be enabled and verified before this reporting
policy is updated to direct researchers to that channel.

الوصول إلى المستودع مقيد حاليًا. يمكن للمساهمين المصرّح لهم الإبلاغ عن
الثغرات المشتبه بها من خلال Issue داخل المستودع الخاص. لا تنشر بيانات
اعتماد أو مقتطفات من المصادر أو تفاصيل استغلال خارج نطاق الوصول المقيد.
قبل إتاحة المستودع للعامة، يجب تفعيل الإبلاغ الخاص عن الثغرات في GitHub
والتحقق منه، ثم تحديث هذه السياسة لتوجيه الباحثين إلى تلك القناة.

## Formal release policy — سياسة الإصدار الرسمي

A formal release is `NO_GO` when any of the following is true:

- A known Critical or High security finding is unresolved.
- A required security test is skipped, blocked, or not run.
- Secret scanning reports an unresolved credential or sensitive value.
- The threat model is missing or stale for the release scope.
- The software bill of materials does not match the release artifacts.
- Release provenance or artifact integrity cannot be verified.
- A security-sensitive behavior lacks documented authorization and failure semantics.

يكون الإصدار الرسمي `NO_GO` عند تحقق أيٍّ مما يلي: وجود نتيجة أمنية حرجة أو عالية غير محلولة، أو تخطي أو حجب فحص أمني مطلوب، أو وجود سر أو بيانات اعتماد غير محلولة في فحص الأسرار، أو نقص نموذج التهديد أو قدمه، أو عدم مطابقة قائمة المواد لملفات الإصدار، أو عدم إمكانية التحقق من المصدر أو سلامة الملفات، أو وجود سلوك حساس أمنياً دون توثيق للتصريح ودلالات الفشل.

## Security principles — مبادئ الأمان

- Least privilege and explicit authorization. / أقل صلاحية وتصريح صريح.
- Local-first processing and data minimization. / معالجة محلية أولاً وتقليل البيانات.
- Fail closed for authorization, integrity, and capability validation. / الفشل المغلق في التفويض وسلامة البيانات والقدرات.
- No raw source content, retrieved slices beyond explicit need, secrets, capabilities, or paths in logs. / لا محتوى خام ولا مقاطع تتجاوز الحاجة الصريحة ولا أسرار ولا قدرات ولا مسارات في السجلات.
- Synthetic test data only. / بيانات اختبار اصطناعية فقط.
- Bounded input size, execution time, memory, output size, and concurrency. / حدود لحجم المدخل وزمن التنفيذ والذاكرة وحجم المخرجات والتزامن.
- Dependency minimization, pinning, review, and continuous vulnerability monitoring. / تقليل التبعيات وتثبيتها ومراجعتها ومراقبة الثغرات المستمرة.
- Coordinated disclosure and evidence-backed remediation. / إفصاح منسق وإصلاح مدعوم بالأدلة.

## Supported versions — الإصدارات المدعومة

No versions are supported yet.

لا توجد إصدارات مدعومة بعد.
