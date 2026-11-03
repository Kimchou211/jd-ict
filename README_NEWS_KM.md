# JD ANALYSIS v2.3 — News Terminal + UI ថ្មី

## អ្វីដែលថ្មី
**News Terminal** (ម៉ឺនុយ ◴) + banner ខាងលើគ្រប់ទំព័រ + UI design ថ្មីទាំងអស់ (`static/ui.css`)។

### ជាន់ទី ១ — Calendar + Blackout (គ្មាន AI)
- ទាញ event USD ដែលប៉ះពាល់មាស: NFP, CPI/Core CPI, PCE, FOMC (rate/statement/presser/minutes), Fed speeches, Jobless Claims, GDP (+ PPI, Retail, ISM, JOLTS, ADP, Unemployment, AHE)។
- **NEWS BLACKOUT** = ពី ~30 នាទីមុន ដល់ ~30 នាទីក្រោយ event។ វាជា **banner ព័ត៌មានតែប៉ុណ្ណោះ** — **មិន block signal ទេ**។ ក្នុងពេលនោះ ICT Terminal នៅតែវិភាគ និងចេញ signal ធម្មតា ប៉ុន្តែ news ត្រូវបានបង្ហាញធំជាងមុន (banner ក្រហម, strip លើ ICT Terminal, countdown) ហើយ AI mentor ត្រូវបានប្រាប់ពី news (ក្នុង `news` field ជា data គ្មានតម្លៃ) ឲ្យលើកឡើងក្នុង risk note និងចាំបញ្ជាក់ក្រោយ release។
- Countdown ដល់ event បន្ទាប់ + បញ្ជី "Up next" + តារាង terminal (ថ្ងៃ/ម៉ោង, impact, T-, Forecast, Previous, Actual, Rule)។
- ប្រភពឥតគិតថ្លៃ: **Finnhub** (`FINNHUB_API_KEY`, មាន Actual) ឬ **Forex Factory** JSON មិនផ្លូវការ (គ្មាន key, តែគ្មាន Actual)។ Cache 15 នាទី (`NEWS_CACHE_SECONDS`) ព្រោះ Forex Factory rate-limit ខ្លាំង។ បើ feed ដាច់ វានៅតែបង្ហាញ cache ចុងក្រោយ (ស្លាក STALE)។

### ជាន់ទី ២ — Rule: Actual vs Forecast vs Previous
- Rule ថេរក្នុង `app/news.py` / `worker/news.ts` (លេខមកពី feed មិនមែន AI)។ ឧ. CPI ខ្ពស់ជាង forecast → ដុល្លារ/yield ឡើង → មាសធ្លាក់ជាមុន (ជួនកាលត្រឡប់វិញ)។
- Polarity: CPI/PCE/PPI/NFP/GDP/Retail/ISM/AHE/Fed rate «ខ្ពស់ជាង = មាសធ្លាក់»; **Unemployment Rate & Jobless Claims បញ្ច្រាស** «ខ្ពស់ជាង = មាសឡើង»។
- Surprise ចែកជា IN_LINE / MILD / STRONG តាម threshold ក្នុង `RULES` (ប្តូរបាន)។
- event ចេញម៉ោងតែមួយ (NFP + Unemployment + AHE) ត្រូវបូកជា **NET** មួយ។
- **Forex Factory គ្មាន Actual**: វាយ Actual ក្នុងជួរ ACTUAL របស់តារាង ហើយចុច Enter។ រក្សាក្នុង browser តែប៉ុណ្ណោះ។ Fed speech គ្មានលេខ → ជ្រើស hawkish / neutral / dovish។
- Rule មិនដឹងបរិបទ (ឧ. NFP ខ្លាំងតែ revision អាក្រក់) ដូច្នេះប្រើជា «ការអានដំបូង» ហើយរង់ចាំ M5/M15 បិទ + ICT structure។

## ការកំណត់
| Variable | លំនាំដើម | ន័យ |
|---|---|---|
| `FINNHUB_API_KEY` | ទទេ | មាន = ប្រើ Finnhub (មាន Actual); ទទេ = Forex Factory |
| `NEWS_BLACKOUT_BEFORE_MIN` | 30 | នាទីមុន event |
| `NEWS_BLACKOUT_AFTER_MIN` | 30 | នាទីក្រោយ event |
| `NEWS_CACHE_SECONDS` | 900 | រយៈពេល cache |

Cloudflare: `npx wrangler secret put FINNHUB_API_KEY` (ជា secret មិនមែនក្នុង config)។ Windows/Python: ដាក់ក្នុង `.env`។

API: `GET /api/news/events?refresh=true`, `GET /api/news/status`, `POST /api/news/analyze {title, actual, forecast, previous}`។

## UI ថ្មី
Design system "Obsidian Gold": glass panel, ពុម្ព Inter + JetBrains Mono + Noto Sans Khmer, animation ទន់ (page transition, countdown flip, shimmer, pulse blackout), mobile bottom-nav, គោរព `prefers-reduced-motion`។ ID/JS ចាស់ទាំងអស់នៅដដែល ដូច្នេះ Analyzer / Live / ICT / History ដំណើរការដូចមុន។

## កំណត់សម្គាល់
- ការជួសជុល: ក្នុងរបៀប Python/Windows កាលពីមុន `/ict.js`, `/ict.css`… មិនត្រូវបាន serve ពី root ទេ។ ឥឡូវ `main.py` មាន route `/{asset}` សម្រាប់ `.js/.css` ក្នុង `static/`។
- Tests: `pytest tests` (មាន `test_news.py`) និង `npm test` (មាន `worker-news.test.ts`)។
