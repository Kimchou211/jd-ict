# JD ANALYSIS v2 — ICT Terminal (បន្ថែមថ្មី)

ទំព័រថ្មី **ICT Terminal** (ម៉ឺនុយខាងឆ្វេង ◈) ដែលស្កេនទីផ្សារមាស XAUUSD ហើយគូរលើ chart ដោយស្វ័យប្រវត្តិ។

## របៀបដំណើរការ
1. ម៉ាស៊ីនគណនា ICT (`app/ict_engine.py`) អាន candle ពិតៗ **H1 → M15 → M5/M1** ដោយមិនប្រើ AI ទាយ៖ swing, BOS/MSS, liquidity (EQH/EQL, PDH/PDL, Asia, CRT) និង sweep, FVG, Order Block, Premium/Discount, CRT, Killzone។
2. វាបង្កើត setup (Entry zone, Stop, TP1, TP2, R:R) ជាមួយ confluence score 0-100។
3. **AI ICT mentor** (DeepSeek) ទទួលលទ្ធផលដែលគណនារួច ហើយអាចតែ *យល់ព្រម ឬ veto*។ វាត្រូវយោង level តាម id (SWEEP1, FVG1, ENTRY…) ប៉ុណ្ណោះ។ បើវាសរសេរតម្លៃដែលមិនមានក្នុង engine **validator នឹងច្រានចោលចម្លើយ AI ទាំងមូល**។ បើ AI និង engine មិនស្របគ្នា លទ្ធផលគឺ **WAIT**។
4. Chart គូរ Sweep, BOS/MSS, FVG/OB, liquidity lines, CRT H/L, Range និងប្រអប់ Entry/Stop/TP ជាមួយ R:R។ ប៊ូតុង Liquidity / Range / Structure / Zones / Plan បើក-បិទ layer។ Scroll/pinch = zoom, drag = pan។

## ការកំណត់ (.env / Cloudflare Worker)
- `TWELVEDATA_API_KEY` ← feed ចម្បង (free key ពី twelvedata.com)។ ទទេ ឬ provider បរាជ័យ = ប្រើ Yahoo ជា fallback (យឺត/មិនស្ថិរជាង)។ សម្រាប់ Cloudflare Worker ដាក់វាជា Worker secret (`npx wrangler secret put TWELVEDATA_API_KEY`) មិនមែន commit ក្នុង config ឬ source code។
- `APP_PASSWORD` (និង `APP_USER`) ← បើដាក់ តម្រូវ login ទាំង app។ ទទេ = គ្មាន login។ **ត្រូវដាក់ បើបើកឲ្យចូលតាម Internet។**
- `ICT_MIN_SCORE=60` ← score ទាបបំផុតសម្រាប់ BUY/SELL។
- `ICT_AI_LANGUAGE=Khmer`
- `ICT_LONDON_KZ_UTC`, `ICT_NY_KZ_UTC`, `ICT_ASIA_UTC` ← ម៉ោង killzone (UTC)។ តម្លៃលំនាំដើមសម្រាប់ម៉ោងរដូវក្តៅ US; រដូវរងាប្តូរទៅ London 8-11, NY 13-16។
- `AUTO_TRACK=true` ← រាល់ ~90 វិនាទី ពិនិត្យ plan ដែលបានរក្សាទុក។

## Auto-track TP/SL
ក្នុង Windows/Docker, plan ទាំងអស់ដែលជា BUY/SELL ត្រូវរក្សាទុកក្នុង Signal History។ ប្រព័ន្ធតាមដាន M5 candles៖ PENDING → FILLED (តម្លៃប៉ះ entry zone) → TP1 / TP2 / SL ហើយ mark លទ្ធផលដោយស្វ័យប្រវត្តិ (រួមទាំង R ពិត)។ បើ candle តែមួយប៉ះទាំង SL និង TP វាចាត់ទុក SL មុន (គិតបែប pessimistic)។ បើតម្លៃទៅដល់ TP ដោយមិនប៉ះ entry វា mark "not taken"។

Cloudflare Worker អាចរក្សា ICT scans ក្នុង Signal History និងបង្ហាញ Daily Win Rate ពីលទ្ធផលដែលបាន mark។ Background auto-tracker មិនទាន់មានក្នុង Worker ទេ; សូម mark TP1/TP2/SL/Not taken ដោយដៃក្នុង Signal History។ Win rate ក្នុង History ប្រើ R ពិតនៅពេលមានក្នុង outcome បើមិនដូច្នោះទេប្រើ multiple លំនាំដើម។

## កំណត់សម្គាល់ដែលត្រូវដឹង
- ទីផ្សារមាសបិទចុង សប្តាហ៍ (សុក្រ ~22:00 UTC → អាទិត្យ ~23:00 UTC)។ ពេលនោះ scan វិភាគ session ចុងក្រោយ ហើយបង្ហាញ WAIT។
- Score គឺ confluence មិនមែនប្រូបាប៊ីលីតេឈ្នះទេ។ ត្រូវតាមដាន win rate ពិតក្នុង History មុនទុកចិត្ត។
- ICT មានទាំងក្នុង Python (`app/`) និង Cloudflare Worker (`worker/ict-engine.ts`)។ Worker មាន routes `/api/ict/candles`, `/api/ict/scan`, និង `/api/stats/daily`; ICT scan គាំទ្រ XAUUSD និង BTCUSD។ Twelve Data ជា feed ចម្បងពេល Worker secret មាន ហើយ Yahoo ជា fallback។
- Tests: `pytest tests` សម្រាប់ Python និង `npm test` សម្រាប់ Worker។

---

## v2.1 — Analyzer រូបភាព + ICT drawing + BTCUSD

### Analyzer លើរូបភាព (Chart Analyzer)
- ជ្រើស **Symbol** (XAUUSD / BTCUSD) នៅផ្នែកលើនៃទំព័រ។ ឈ្មោះ symbol ត្រូវមើលឃើញក្នុងរូបទាំងពីរ។
- Prompt ដែលផ្ញើទៅ Gemini/DeepSeek (vision) ឥឡូវមាន **ICT drawing mode**៖ AI ត្រូវសម្គាល់ BOS, MSS, Sweep, FVG, OB, EQH/EQL, PDH/PDL, CRT H/L ជាមួយ `layer` ហើយ marks ទាំងនោះមិនលើសពី 12 ក្នុងមួយរូប។ វាត្រូវគូរតែអ្វីដែលមើលឃើញច្បាស់ ប៉ុណ្ណោះ។
- Overlay លើរូបគូរ **BOS/MSS chip, Sweep marker, FVG/OB box, liquidity/CRT lines** និង **ប្រអប់ Entry/Stop/TP ក្រហម/បៃតង + R:R** (ប្រអប់នេះដាក់តាម price axis ដែលអានបាន)។
- ប៊ូតុង filter Liquidity / Range / Structure / Zones / Plan + "AI · N drawings" (👁 លាក់ទាំងអស់, ✕ សម្អាត) នៅក្រោមរូបនីមួយៗ។
- **ដែនកំណត់៖** ទីតាំង ICT marks ដែលគូរលើរូបភាពមកពី vision model ដូច្នេះប្រហែលៗ ហើយអាចខុស។ ចំណុចនេះមិនអាចដោះស្រាយបានពេញលេញពីរូបភាពទេ។ សម្រាប់ level ត្រឹមត្រូវពិតប្រាកដ ប្រើ ICT Terminal (គណនាពី candle ពិត)។

### BTCUSD
- ICT Terminal៖ ជ្រើស symbol នៅ toolbar។ Feed = Twelve Data `BTC/USD` (fallback Yahoo `BTC-USD`)។ Bitcoin ជួញដូរ 24/7 ដូច្នេះមិនមាន "market closed" ចុងសប្តាហ៍។
- Threshold ទាំងអស់ (ទំហំ FVG, equal-highs tolerance, stop buffer, AI validator, tolerance តម្លៃ) ធ្វើមាត្រដ្ឋានតាម symbol (`app/symbols.py`)។ អាចបន្ថែម symbol ផ្សេងទៀតបានដោយបន្ថែម profile។
- Analyzer រូបភាព៖ ជួរតម្លៃ ការផ្ទៀងផ្ទាត់ symbol និង tolerance ប្តូរទៅ BTC។
- Auto-track ប្រើ symbol របស់ plan នីមួយៗ។
- **មិនទាន់រួមបញ្ចូល BTC៖** ទំព័រ "Live Chat Terminal" ចាស់ (EMA/RSI) នៅតែ XAUUSD តែមួយ។ ICT Terminal ជំនួសតួនាទី live សម្រាប់ BTC។

---

## v2.2 — Signal History: Result ស្វ័យប្រវត្តិ + Win rate ប្រចាំថ្ងៃ
- **Result column**៖ បង្ហាញ `◌ WAITING` (រង់ចាំតម្លៃចូល entry) → `● RUNNING` (បានចូលហើយ) → `✔ TP1 HIT` / `✔ TP2 HIT` / `✖ SL HIT` ជាមួយ R និងម៉ោងដែលប៉ះ។ ទំព័រ refresh ខ្លួនឯងរៀងរាល់ 45 វិនាទី។
- **ដំណើរការសម្រាប់ signal គ្រប់ប្រភេទ** (ICT Terminal, Analyzer រូបភាព, Live) ដែលមាន Entry zone + SL + TP1។ Signal ដែលមាន level ខុសជ្រុង (ឧ. SELL ដែល SL ទាបជាង entry) មិនត្រូវបាន track ទេ។
- **Daily Win Rate** (ផ្នែកខាងលើទំព័រ)៖ win rate ថ្ងៃនេះ + តារាង 14 ថ្ងៃ (TP1/TP2/SL/Open, Win rate, Total R)។ Win = TP1 ឬ TP2, Loss = SL។ "Not taken" និង signal ដែលនៅបើកមិនត្រូវរាប់។ ថ្ងៃគិតតាមម៉ោងក្នុង browser របស់អ្នក (GMT+7) ហើយគិតតាមថ្ងៃដែល signal ត្រូវបង្កើត។
- **ច្បាប់តាមដាន**៖ ពិនិត្យរៀងរាល់ ~90 វិនាទី ដោយប្រើ M5 candles។ បើ candle តែមួយប៉ះទាំង SL និង TP វាចាត់ទុក SL មុន។ Signal ដែលមិនទាន់ចូល entry ក្នុង 6 ម៉ោង = "not taken"។ Signal ចាស់ជាង 36 ម៉ោងមិនត្រូវ track ទេ (នៅតែ mark ដោយដៃបាន)។
- ជាមួយ Analyzer រូបភាព តម្លៃ entry/SL/TP មកពីការអានរូប ដូច្នេះ result ក៏ពឹងលើភាពត្រឹមត្រូវនៃការអាននោះដែរ។

---

## v2.3 — News Terminal + UI ថ្មី
មើល `README_NEWS_KM.md`។ ICT scan ឥឡូវភ្ជាប់ `news` context (blackout, event បន្ទាប់) ទៅ AI mentor និងបង្ហាញ strip លើទំព័រ ICT។ News មិន block signal ទេ។
