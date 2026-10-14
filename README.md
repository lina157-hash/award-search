# 機票搜索雷達（里程票與現金票查詢）

用 seats.aero Partner API 查詢國泰、法航、加航、長榮、華航等航空公司的里程票座位，並附上航空聯盟與里程計畫規則庫。

## 功能
- **航線查詢**：輸入出發/抵達機場（可多個，用逗號分隔）、日期（在日曆點選範圍，或點一個日期再選前後 ±1～±180 天，最多可查一年）、航空公司、艙等，以「日期 × 里程計畫」表格顯示最低里程與剩餘座位，點格子看航班明細與訂位連結。
- **里程票附加資訊**：比較表與「最划算」卡片會列最低稅金（日期範圍 45 天內）、資料更新時間（超過一天未更新的格子打灰）；可篩「至少 N 位」座位；航班明細裡可按「和當天現金票比一比」算出每哩價值（會用 1 次現金票查價額度，匯率每日自動更新）；查過的航線會記在裝置上，也可加入「我的常用」。
- **區域探索**：選一個里程計畫、出發/抵達區域與日期（同樣可點選範圍或 ± 天數），列出區域內所有有位子的航線，依里程排序。
- **查現金票**（現金票）：查一般付費機票價格（來回／單程、多機場、艙等、人數、轉機、聯盟），資料來自 Google 航班（透過 SerpApi），附價格水準與走勢、航班明細，以及到 Google 航班、Skyscanner 的連結。來回票選完去程、回程（單程選一班）後會進到「已選取的航班」確認畫面，列出兩段航班與總價，可再查 Google 航班的預訂選項（航空公司官網、旅行社價格，另扣 1 次查價額度）。
- **機位提醒**：搜尋結果上方按「🔔 有新機位通知我」，網站每天早上 8 點多（台灣時間，seats.aero 額度重置後）自動重查，新出現的獎勵位會寄信通知（已存在的不重複）。需要在 Vercel 設定儲存與寄信服務，見下方部署說明。
- **加到手機主畫面**：有 manifest 與圖示，手機瀏覽器「加入主畫面」後像 App 一樣全螢幕開啟。
- **點數換算器**：輸入台灣信用卡點數看各銀行能換多少哩，或輸入目標哩程看要多少點，已算進最低門檻與兌換單位，預設只顯示結果，可切換顯示比率與備註；比率在 `data/points.json` 的 `calc.sources`。
- **規則庫**：航空聯盟成員、各里程計畫的計價方式、單程、中停、開口、燃油費、改退票、效期、家人合併、台灣信用卡點數轉里程規則表與聯名卡（`data/points.json` 的 `transfers`／`cobrand`），以及里程票與現金票的基本觀念。資料在 `data/*.json`，直接編輯即可更新。

## 版本與更新紀錄

頁尾會顯示版本號、最後更新日期、更新紀錄，以及目前部署的程式版本（Vercel 提供的 commit）。改完東西要上線前，先跑：

```
node scripts/bump-version.js patch "這次改了什麼"   # 小修正：1.9.0 → 1.9.1
node scripts/bump-version.js minor "新增 XX 功能"   # 新功能：1.9.0 → 1.10.0
```

它會更新 `data/version.json` 的版本號、日期（台北時間）與更新紀錄，再一起 commit 即可。

## 執行
需要 Node.js 20 以上，沒有其他相依套件。

```bash
cp .env.example .env          # 填入 SEATS_AERO_API_KEY
export $(grep -v '^#' .env | xargs)
npm start                     # http://localhost:3000
npm test
```

沒有設定 `SEATS_AERO_API_KEY` 時會以**示範資料**模式運作，畫面上方會有提示。

## 設計重點
- API 金鑰只存在伺服器端環境變數，前端呼叫 `/api/*`，由伺服器轉發至 seats.aero。
- 同樣查詢會在記憶體快取 30 分鐘（`CACHE_TTL_SECONDS`），節省每日 1,000 次的 Pro 額度。公開的查詢（里程搜尋、區域探索、出發前小提醒、匯率、今日好康、資料檔）另外交給 Vercel 的 CDN 快取（`s-maxage`），換一台伺服器也不會重查；要通關密碼的查詢（現金票、飯店現金價、提醒、追蹤）不走 CDN，改用 Upstash Redis 共用快取 30–60 分鐘，同樣的查詢、連點兩下都只扣一次額度。
- 「今天」一律用台灣時間判斷。
- seats.aero 有收錄亞洲萬里通（source `asiamiles`，官方文件未列出），但沒有長榮、華航自家里程計畫；這兩家以可換到其座位的夥伴計畫（見 `data/airlines.json` 的 `bookableVia`）呈現。沒有亞洲萬里通資料的寰宇一家航線，前端會依 `data/asiamiles.json` 的距離哩數表估算。
- 機場清單（`public/airports.min.json`，約 3,200 個有定期航班的機場）由 `scripts/build-airports.js` 產生：機場資料來自 OurAirports（公有領域），城市別名來自 airportsdata（MIT，© Mike Borsetti），常用機場中文名與多機場城市（東京、倫敦等）在 `data/airport-names-zh.json` 手動維護。改了中文名之後重新執行該腳本即可。

## 注意
- seats.aero Pro 金鑰僅限個人使用；公開或商業網站需與 seats.aero 簽署書面合作。
- 規則庫為自行整理的摘要，標示「待核實」的計畫需到官方網站確認後更新。

## 部署到 Vercel（從 GitHub 匯入）
1. 在 Vercel 選「Add New → Project」，匯入這個 GitHub repo，Framework 選 **Other**。
2. 在 Environment Variables 新增 `SEATS_AERO_API_KEY`，值填你的 seats.aero 金鑰。
3. 按 Deploy。之後每次推送到 main 都會自動重新部署。
4. （選用）查現金票通關密碼：在 Environment Variables 新增 `CASH_PASSCODE`（任意字串）後重新部署，之後只有輸入過密碼的裝置才能用 SerpApi 即時查價（里程票查詢不受影響）。沒設定就不鎖。
5. （選用）現金票即時價格：到 serpapi.com 註冊取得金鑰，在 Environment Variables 新增 `SERPAPI_KEY` 後重新部署。免費方案每月 250 次查詢；每次搜尋、「看回程」或「查預訂選項」各用 1 次，同樣條件 30 分鐘內重查不會再扣。沒設定時「查現金票」分頁只提供 Google 航班與 Skyscanner 連結。

6. （選用）機位提醒：在 Vercel 專案的 **Storage** 分頁，透過 Marketplace 建立一個 **Upstash Redis**（免費方案），連線設定會自動加入；再到 resend.com 註冊、建立 API 金鑰，新增環境變數 `RESEND_API_KEY`（沒驗證網域時，只能寄到你註冊 Resend 的信箱）。請設定 `CRON_SECRET`（任意長字串）：Vercel 的排程會帶著它呼叫，沒有它、也沒有通關密碼時，排程端點一律拒絕。可另設 `ALERT_FROM` 自訂寄件人。重新部署後，`vercel.json` 裡的 cron 每天 00:10 UTC（台灣 08:10，seats.aero 每日額度剛重置）呼叫 `/api/alerts/run`，依序更新今日好康、降價追蹤、機位提醒；01:10 UTC 再跑一次 `/api/cron/daily` 補做前一次沒做完的部分（已做過的會跳過，不會重扣額度或重複寄信）。Hobby 方案的排程可能在該小時內任何時間觸發。也可以在網站的「機位提醒」面板按「立即檢查全部」。設定了 `CASH_PASSCODE` 的話，管理提醒也要輸入同一組密碼。

7. （選用）「誰飛直航」用同一把 `RAPIDAPI_KEY` 的 AeroDataBox（每月約 400 單位，每個出發機場 6 單位，存兩週）。台灣各機場與香港、東京、大阪、首爾、曼谷、新加坡任何人都能查；其他出發機場要通關密碼。每月剩 40 單位時自動停止查新機場；如果你的方案額度不同，可設 `DIRECTS_MONTHLY_UNITS`。
8. （選用）Telegram 通知：在 Telegram 找 @BotFather，傳 `/newbot` 建立自己的機器人，複製它給的金鑰，在 Vercel 新增環境變數 `TELEGRAM_BOT_TOKEN` 後重新部署（需要已設定 `CASH_PASSCODE` 和 Upstash Redis）。接著在 Telegram 打開你的機器人按「開始」（傳送 `/start`），再回網站按「連結 Telegram」；收到「機票搜索雷達已連結」就完成了。之後新機位提醒和降價通知除了 Email 也會傳到 Telegram。
9. （選用）帳號同步：有 Upstash Redis 就能用 Email＋密碼註冊，在不同裝置同步點數、收藏、最近搜尋、行程等個人設定（不登入也一切照舊）。驗證信和重設密碼信透過同一個 `RESEND_API_KEY` 寄出；沒設定寄信時帳號直接啟用、無法用「忘記密碼」。登入後輸入過一次通關密碼，同一個帳號在其他裝置也算已解鎖（只存加鹽雜湊，改了 `CASH_PASSCODE` 就要重新輸入）。

前端放在 `public/`，`/api/*` 由 `api/index.js` 這支 serverless function 處理，金鑰不會出現在瀏覽器端。
