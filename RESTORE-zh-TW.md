# Dashboard 原始碼還原

這是沃克思 Dashboard 的原始碼包。包含畫面、業務計算、Google Sheets 讀取介面、測試及 pnpm 鎖定檔；不包含 node_modules、建置輸出、實際客戶／財務資料或登入憑證。

## 本機環境

- Node.js 22.13.0 以上。
- pnpm 11.25.0（與 package.json 一致）。
- 在解壓後、含 package.json 的目錄執行：

```text
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm dev
```

依終端機顯示的 localhost 網址開啟預覽。沒有登入／連接器執行環境的純本機啟動，不會自動取得 Google Sheets 存取權。正式環境透過已登入帳號的 Google Drive 連接讀取，並不把財務資料打包在網站內。

## 後台及部署

- 六分頁維護與 KPI 計算方式見 SIX-TABS.md。
- 資料欄位契約在 lib/domain/schema.json；資料來源位置在 lib/server/source-target.json。更換試算表時須一併符合欄位及原有授權。
- 文件完整性邏輯在 lib/domain/coverage.ts，畫面在 components/document-coverage.tsx。
- .openai/hosting.json 保留目前 Site 識別；重新部署現有 Site 應保留，另建 Site 請透過 Sites 的正式建立流程更新識別與授權。
- 建置請使用 Sites 支援的 build-site.mjs 及 site-workflow.mjs 流程；一般環境可用 pnpm build 檢查建置。

這個包可還原程式，但不會複製 Google Sheets 資料、Google Drive 原件、網站存取權或帳號連接。歷史文件匯入腳本與本機來源稽核檔屬獨立維運資料，未包含在此程式碼包。
