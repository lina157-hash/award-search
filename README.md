# 機票搜索雷達（里程票與現金票查詢）

用 seats.aero Partner API 查詢國泰、法航、加航、長榮、華航等航空公司的里程票座位，並附上航空聯盟與里程計畫規則庫。

## 功能
- **航線查詢**：輸入出發/抵達機場（可多個，用逗號分隔）、日期（在日曆點選範圍，或點一個日期再選前後 ±1～±180 天，最多可查一年）、航空公司、艙等，以「日期 × 里程計畫」表格顯示最低里程與剩餘座位，點格子看航班明細與訂位連結。
- **里程票附加資訊**：比較表與「最划算」卡片會列最低稅金（日期範圍 45 天內）、資料更新時間（超過一天未更新的格子打灰）；可篩「至少 N 位」座位；航班明細裡可按「和當天現金票比一比」算出每哩價值（會用 1 次現金票查價額度，匯率每日自動更新）；查過的航線會記在裝置上，也可加入「我的常用」。
- **區域探索**：選一個里程計畫、出發/抵達區域與日期（同樣可點選範圍或 ± 天數），列出區域內所有有位子的航線，依里程排序。
- **買機票**（現金票）：查一般付費機票價格（來回／單程、多機場、艙等、人數、轉機、聯盟），資料來自 Google 航班（透過 SerpApi），附價格水準與走勢、航班明細，以及到 Google 航班、Skyscanner 的連結。
- **機位提醒**：搜尋結果上方按「🔔 有新機位通知我」，網站每天早上 7 點（台灣時間）自動重查，新出現的獎勵位會寄信通知（已存在的不重複）。需要在 Vercel 設定儲存與寄信服務，見下方部署說明。
- **加到手機主畫面**：有 manifest 與圖示，手機瀏覽器「加入主畫面」後像 App 一樣全螢幕開啟。
- **點數換算器**：輸入台灣信用卡點數看各銀行能換多少哩，或輸入目標哩程看要多少點，已算進最低門檻與兌換單位；比率在 `data/points.json` 的 `calc.sources`。
- **規則庫**：航空聯盟成員、各里程計畫的計價方式、單程、中停、開口、燃油費、改退票、效期、家人合併、台灣信用卡點數轉里程規則表與聯名卡（`data/points.json` 的 `transfers`／`cobrand`），以及里程票與現金票的基本觀念。資料在 `data/*.json`，直接編輯即可更新。

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
- 同樣查詢會在記憶體快取 30 分鐘（`CACHE_TTL_SECONDS`），節省每日 1,000 次的 Pro 額度。
- seats.aero 有收錄亞洲萬里通（source `asiamiles`，官方文件未列出），但沒有長榮、華航自家里程計畫；這兩家以可換到其座位的夥伴計畫（見 `data/airlines.json` 的 `bookableVia`）呈現。沒有亞洲萬里通資料的寰宇一家航線，前端會依 `data/asiamiles.json` 的距離哩數表估算。
- 機場清單（`public/airports.min.json`，約 3,200 個有定期航班的機場）由 `scripts/build-airports.js` 產生：機場資料來自 OurAirports（公有領域），城市別名來自 airportsdata（MIT，© Mike Borsetti），常用機場中文名與多機場城市（東京、倫敦等）在 `data/airport-names-zh.json` 手動維護。改了中文名之後重新執行該腳本即可。

## 注意
- seats.aero Pro 金鑰僅限個人使用；公開或商業網站需與 seats.aero 簽署書面合作。
- 規則庫為自行整理的摘要，標示「待核實」的計畫需到官方網站確認後更新。

## 部署到 Vercel（從 GitHub 匯入）
1. 在 Vercel 選「Add New → Project」，匯入這個 GitHub repo，Framework 選 **Other**。
2. 在 Environment Variables 新增 `SEATS_AERO_API_KEY`，值填你的 seats.aero 金鑰。
3. 按 Deploy。之後每次推送到 main 都會自動重新部署。
4. （選用）買機票通關密碼：在 Environment Variables 新增 `CASH_PASSCODE`（任意字串）後重新部署，之後只有輸入過密碼的裝置才能用 SerpApi 即時查價（里程票查詢不受影響）。沒設定就不鎖。
5. （選用）現金票即時價格：到 serpapi.com 註冊取得金鑰，在 Environment Variables 新增 `SERPAPI_KEY` 後重新部署。免費方案每月 250 次查詢；每次搜尋或「看回程」各用 1 次，同樣條件 30 分鐘內重查不會再扣。沒設定時「買機票」分頁只提供 Google 航班與 Skyscanner 連結。

6. （選用）機位提醒：在 Vercel 專案的 **Storage** 分頁，透過 Marketplace 建立一個 **Upstash Redis**（免費方案），連線設定會自動加入；再到 resend.com 註冊、建立 API 金鑰，新增環境變數 `RESEND_API_KEY`（沒驗證網域時，只能寄到你註冊 Resend 的信箱）。可另設 `CRON_SECRET` 保護排程端點、`ALERT_FROM` 自訂寄件人。重新部署後，`vercel.json` 裡的 cron 每天 23:00 UTC（台灣 07:00）會呼叫 `/api/alerts/run`；也可以在網站的「機位提醒」面板按「立即檢查全部」。設定了 `CASH_PASSCODE` 的話，管理提醒也要輸入同一組密碼。

前端放在 `public/`，`/api/*` 由 `api/index.js` 這支 serverless function 處理，金鑰不會出現在瀏覽器端。
