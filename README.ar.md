<div dir="rtl">

# mods

[English](README.md) · **العربية**

إضافات (mods) من إعداد أحمد لـ Claude Code، منشورة على شكل متجر إضافات (plugin marketplace) يمكن تثبيت أي إضافة منه بأمرين.

| الإضافة | ماذا تفعل |
|---|---|
| [journey](journey/README.ar.md) | خط مترو للمهمة التي تعمل عليها: كل محطة من الآن حتى الانتهاء، وفي أي محطة تقف الجلسة الآن، ولماذا. يُرسم في لوحة جانبية ويُثبَّت في سطر الحالة أسفل مربع الكتابة. |

</div>

<p align="center"><img src="journey/docs/screenshot.png" width="560" alt="لوحة journey: خط مترو للمهمة، فيه المحطات المنجزة، والمحطة الحالية وسبب الوقوف عندها، والمحطات التي تنتظر قرارك"></p>

<div dir="rtl">

## التثبيت

تحتاج إلى Claude Code مثبتًا على جهازك. افتح الطرفية (Terminal أو PowerShell) ونفّذ الأمرين التاليين بالترتيب:

**١. أضف المتجر.** يخبر هذا الأمر Claude Code بمكان هذه الإضافات على GitHub:

</div>

```
claude plugin marketplace add AhmedQureshi89/mods
```

<div dir="rtl">

**٢. ثبّت الإضافة.** الاسم بعد علامة `@` هو اسم المتجر:

</div>

```
claude plugin install journey@ahmed-mods
```

<div dir="rtl">

**٣. ابدأ جلسة جديدة** في Claude Code حتى تُحمَّل الإضافة.

أو من داخل Claude Code نفسه (الإصدار 2.1.275 أو أحدث)، بخطوة واحدة:

</div>

```
/plugin install journey --marketplace AhmedQureshi89/mods
```

<div dir="rtl">

## الاستخدام

لا تحتاج إلى إعداد أي شيء بعد التثبيت. عندما تطلب من Claude مهمة فيها أكثر من خطوتين، يرسم Claude خط الرحلة بنفسه قبل أن يبدأ، وتفتح اللوحة تلقائيًا. تفاصيل الاستخدام والأوامر في [دليل journey بالعربية](journey/README.ar.md).

## الترخيص

MIT — راجع ملف [LICENSE](LICENSE).

</div>
