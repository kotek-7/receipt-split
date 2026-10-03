# 実画像のレシート評価

実画像と固定した正解データを使い、OCR と品目抽出の精度を別々に確認します。データセットの取得・公開条件は、各データセットの配布元で確認してください。Tesseract の runner は画像を外部 API に送りません。初回実行時は日本語・英語モデルをダウンロードします。AI の runner は評価画像を Cloudflare Workers AI へ送信します。

## 正解データ

画像と次の JSON を用意します。`image` は manifest の位置からの相対パス、または絶対パスです。`amount` は品目行の合計金額で、単価ではありません。`quantity` を省略した品は 1 個として評価します。値引きは負の金額です。

```json
{
  "dataset": "receipt-photos",
  "revision": "v1",
  "license": "配布元のライセンスと URL",
  "fixtures": [
    {
      "id": "receipt-001",
      "image": "images/001.jpg",
      "split": "dev",
      "expected": {
        "total": 3000,
        "items": [
          { "name": "生ビール", "amount": 1800, "quantity": 3 },
          { "name": "唐揚げ", "amount": 1200 }
        ]
      }
    }
  ]
}
```

`dev` は改善箇所を調べる画像、`holdout` は改善後の確認に残す画像です。分割と正解は改善前に確定し、結果に合わせて入れ替えないでください。店舗・撮影条件の近い画像が両方に偏って混ざる場合、未知のレシートへの精度としては過大評価になります。新しい正解を採用するときは revision を更新し、両方の実装を同じ正解で評価し直します。

## 実行

依存関係をインストール済みのリポジトリで実行します。アプリと同じ紙面検出・切り抜き・PNG 変換を使う場合は次のローカルサーバーを起動し、表示された URL で「評価画像を準備」を押します。画像も正解も外部へ送信しません。

```sh
node --import tsx scripts/receipt-eval/prepare-browser.mjs artifacts/receipt-datasets/jawildtext/manifest.json --output /tmp/receipts-browser --port 4319
```

元画像は manifest に登録されたものだけを読み、全件成功した後に準備済み manifest を作成します。元画像と出力画像、前処理のソース、ブラウザーの情報を記録し、既存の出力先は上書きしません。元の GT と dev / holdout 分割は変えません。処理が終わったらサーバーを終了できます。

紙面を切り抜かず、縮小だけで比較する場合は Python 3 と Pillow も使用できます。こちらの結果はブラウザーの前処理と区別してください。

```sh
python3 scripts/receipt-eval/prepare.py /tmp/receipts/manifest.json --output /tmp/receipts-prepared
node --import tsx scripts/receipt-eval/run.mjs /tmp/receipts-prepared/manifest.json --output /tmp/receipts-baseline --split dev
```

`--split holdout` で保留画像、`--split all` で両方を実行できます。既定値は `all` です。言語モデルの再ダウンロードを避ける場合、`--cache /tmp/receipt-language-cache` を指定します。1 ワーカーで画像を順番に認識し、初期化時間と画像ごとの処理時間を分けて残します。

結果は次の 2 ファイルに保存します。

- `results.json`: manifest と入力画像・パーサーの SHA-256、OCR エンジンのバージョン、生テキスト、信頼度、座標を含む blocks、処理時間、抽出した品目・数量・合計。画像ごとの失敗も保存します。
- `report.json`: 全体・分割別・画像別の一致件数、precision、recall、F1、合計金額の一致率。

OCR 失敗画像を評価対象から取り除きません。品目は未検出、合計は不一致として評価し、コマンドは終了コード 1 を返します。実行が中断されても完了済み画像の OCR は保存されます。不完全な結果を全件の結果として再評価しようとするとエラーになります。

パーサーだけを変更した場合は、画像を再認識せずに同じ生テキストを解析します。元の結果を保存するため、別の出力先を指定します。

```sh
node --import tsx scripts/receipt-eval/reparse.mjs /tmp/receipts-prepared/manifest.json /tmp/receipts-baseline/results.json --output /tmp/receipts-reparsed
```

`reparse.mjs` は manifest のハッシュが違う場合に停止します。比較途中の正解や画像一覧の変更を防ぐためです。元の OCR 信頼度・座標・処理時間はそのまま引き継ぐので、再解析結果の `latencyMs` は新パーサーの処理時間ではありません。

## 評価方法

AI と比較する場合は、Wrangler へログインした環境で同じ準備済み manifest を渡します。**選択した画像を Cloudflare へ送信します**。公開データ、または送信の許可を得た画像を使用してください。

```sh
node --import tsx scripts/receipt-eval/run-ai.mjs /tmp/receipts-prepared/manifest.json --output /tmp/receipts-ai-dev --split dev
```

本番と同じモデル・プロンプト・応答検証を使用し、正解データはモデルに渡しません。モデル名、プロンプト・画像・manifest のハッシュ、処理時間、利用量、通信試行を記録します。AI の生応答を含む評価結果は Git 管理外に保存してください。本番 API は生応答を保存しません。通信失敗や形式不正も全体の失敗として数えます。認証・通信の再試行がある場合は個別の試行を記録し、成功した画像だけを選び直して集計しません。モデルが正しく読めた場合の成績と、通信込みの利用成功率は区別してください。

Worker の画像検証・制限・応答処理を含めて測る場合は、準備済みの画像を本番 API に送ります。この方法には Wrangler の認証は不要です。

```sh
node --import tsx scripts/receipt-eval/run-http.mjs /tmp/receipts-browser/manifest.json --endpoint https://reciwake.kotek7.com/api/receipt-scan --output /tmp/receipts-http-dev --split dev
```

送信開始の間隔を 11 秒以上空け、クライアント側では再試行しません。通信失敗も保存します。`--expected-deployment-sha` は照合用のデプロイ版を記録する引数で、サーバーの版を自動検証するものではありません。実行前に CI/CD のデプロイ先とコミットを確認してください。

実画面から測る場合は、元画像を「写真から選ぶ」で選択し、読み取り後の編集欄の品名・数量・行金額・総額を記録します。作成ボタンを押す必要はありません。この経路は画像前処理と画面反映も含むため、API runner の処理時間とは分けて集計します。[今回の測定結果](../../docs/receipt-recognition-research.md)では、通信環境の失敗記録も区別して残しています。

品名を NFKC 正規化して空白を除去し、行の順序によらず一対一で対応させます。大文字・小文字、句読点、読み違えた文字はそのまま評価します。数量は完全一致です。3 個を 1 個ずつ 3 行に展開した結果は、正解の 1 行とは一致しません。

- `exactItems`: 品名・行の金額・数量がすべて一致した品目。
- `amountQuantity`: 行の金額・数量が一致した品目。品名の誤りと、金額・数量の誤りを切り分ける補助指標です。同額の別商品を区別できないので、この値だけで正確と判断しません。
- `totalAccuracy`: 合計金額の完全一致率。品目の合計ではなく、レシートに記された支払総額を正解にします。

同額商品や同名商品が複数あっても、同じ予測行を何度も使って一致件数を増やしません。余分な予測は precision、不足は recall を下げます。全体の F1 は全画像の一致件数と行数を合算した micro F1 です。品目が正解・予測ともに 0 行なら F1 を 1 とし、片方だけ 0 行なら 0 とします。対象画像が 0 件の分割は未評価なので、precision・recall・F1 と合計一致率を `null` とします。

## 比較の範囲

baseline は Tesseract.js、日本語＋英語、OEM 1、PSM 6、空白保持、DPI 300 です。`prepare.py` の既定値はアプリと同じ長辺 3,200 px・192 万画素ですが、Pillow の LANCZOS とブラウザーの画像縮小は画素単位では一致しません。

`prepare.py` は **ブラウザーの紙面検出・切り抜きを通しません**。EXIF の向きと透過画像の白背景は処理しますが、画像を縮小するだけなので、背景を含む写真でアプリと同じ結果を保証しません。`prepare-browser.mjs` は実際のアプリの前処理を呼び出しますが、カメラによる撮影やモバイルでの処理時間は別途確認が必要です。どちらも、少数の特定店舗の結果を日本語レシート全般の精度として扱わないでください。

通常の `npm test` では評価関数だけをテストし、モデルのダウンロードや第三者画像の OCR は実行しません。
