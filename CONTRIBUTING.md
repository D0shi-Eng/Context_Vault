# Contributing to ContextVault

> **المساهمة في ContextVault — المساهمة في ContextVault**

ContextVault is not accepting external contributions while contribution, review, and release controls are being finalized.

لا يقبل ContextVault مساهمات خارجية حتى اكتمال ضوابط المساهمة والمراجعة والإصدار.

## Future contribution requirements — متطلبات المساهمة المستقبلية

When contributions open, every change must:

- Be original work or carry a clearly compatible license and attribution.
- Comply with the Apache License, Version 2.0.
- Include tests proportional to risk.
- Preserve Clean Architecture dependency boundaries.
- Use English for code identifiers, comments, docstrings, schemas, errors, and developer documentation.
- Avoid `any` outside isolated and documented compatibility boundaries.
- Avoid secrets, production data, customer content, and machine-specific paths.
- Pass formatting, linting, type checking, tests, security scans, and license checks.
- Document security implications and update affected Architecture Decision Records.

عند فتح المساهمة، يجب أن يكون كل تغيير: عملاً أصلياً أو برخصة متوافقة وإسناد واضح، ومطابقاً لرخصة Apache 2.0، ومع اختبارات تتناسب مع الخطورة، مع الحفاظ على حدود المعمارية النظيفة، والاستخدام الإنجليزي للمعرفات والتعليقات والمخططات والأخطاء والتوثيق التقني، وتجنب `any` خارج حدود توافق معزولة وموثقة، وتجنب الأسرار وبيانات الإنتاج ومحتوى العملاء والمسارات الخاصة بالأجهزة، مع اجتياز التنسيق والفحص الساكن والفحص النوعي والاختبارات وفحوص الأمان والتراخيص، وتوثيق الأثر الأمني وتحديث سجلات القرار المعمارية المتأثرة.

## Developer Certificate of Origin — شهادة منشأ المطور

Contributors will be required to certify the Developer Certificate of Origin using a `Signed-off-by` trailer in each commit. The exact workflow will be enabled before external contributions open.

سيُطلب من المساهمين التصديق على شهادة منشأ المطور باستخدام سطر `Signed-off-by` في كل التزام. سيُفعَّل سير العمل الدقيق قبل فتح المساهمات الخارجية.

## Review policy — سياسة المراجعة

No change may bypass required status checks. Security-sensitive changes require review by a designated security reviewer. Critical policy, authorization, cryptography, storage, and release changes require explicit maintainer approval.

لا يمكن لأي تغيير تجاوز فحوص الحالة المطلوبة. تتطلب التغييرات الحساسة أمنيًا مراجعة مراجع أمني معيّن. تتطلب تغييرات السياسة الحرجة والتفويض والتشفير والتخزين والإصدار موافقة صريحة من المشرف.
