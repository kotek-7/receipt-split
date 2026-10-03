# レシート画像の評価データ

日本語の実写レシートと合成レシートを、固定した配布版から少量だけ取得する。モデルの結果を見て評価対象を選ばない。画像・元の正解データ・正規化した正解・ライセンスは `artifacts/receipt-datasets/` に保存する。このディレクトリは Git 管理外。

## 取得と検証

Python 3 と curl を使用する。追加の Python パッケージは不要。

```sh
python3 scripts/receipt-datasets/download.py
PYTHONDONTWRITEBYTECODE=1 python3 scripts/receipt-datasets/test_normalize.py
```

出力先は `--output /path/to/datasets` で変更できる。片方だけ取得する場合は `--dataset jawildtext` または `--dataset jomb-alpha10` を指定する。初回調査で取得したデータが残っていれば再利用できる。

```sh
python3 scripts/receipt-datasets/download.py --cache /tmp/receipt-ocr-datasets
```

`sources.lock.json` は元画像・元 GT・配布元の説明・ライセンスの SHA-256 を固定する。既存ファイルも毎回検証し、不一致なら処理を止める。壊れたファイルを修正した場合は、明示的に削除して再取得する。

JaWildText は巨大な Parquet 全体を取得せず、Hugging Face の rows API から対象の 30 例だけ取得する。API 応答の `x-revision` が固定版と異なる場合は処理を止める。旧版を再現するときは SHA が一致する保存済みデータを使用する。配布版変更時に評価対象を黙って差し替えない。JOMB はコミット SHA を含む URL から取得する。

## 採用データ

| データ                                                                                                | 種類・公開規模                                                                                 | 今回の固定対象                                       | 配布条件                                                   |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------- |
| [JaWildText / receipt_kie](https://huggingface.co/datasets/llm-jp/jawildtext)                         | 日本語の実写。公開 `receipt_kie` は 1,151 例。文字領域、商品名、数量、行金額、総額、税額の注釈 | 先頭 30 例。行 0〜9 を dev、10〜29 を holdout に予約 | 画像・注釈とも Apache-2.0。配布元 README と LICENSE を保存 |
| [Japan OCR Mini Benchmark / Alpha10](https://huggingface.co/datasets/K10124/japan-ocr-mini-benchmark) | 日本語の合成画像。Alpha10 は 10 例。商品名、数量、単価、行金額、税、総額の JSON                | 承認済み Alpha10 全 10 例を dev に使用               | Alpha10 に限り CC BY 4.0 を明示。確認文書・NOTICE を保存   |

固定 revision:

- JaWildText: `627ca7ea7c224ffe1accff8737991fc2240784fa`
- JOMB: `c82efda5b823494424e6bc6e9ae7577396ded908`

取得した 40 画像のうち、この変換規則で評価可能なのは **実写 dev 10、実写 holdout 11、合成 dev 10 の計 31 画像**。予約した holdout の 9 画像は総額または明細の GT が欠損・数値として読めないため画像全体を除外する。除外理由は `manifest.json` の `skipped`、除外前の対象一覧は `source-lock.json` に残す。除外はモデル実行前の規則に従う。holdout は改善中に画像や抽出結果を読まず、最終比較まで残す。

実写 dev にはレストラン、スーパー、持ち帰りのほか、玩具・自転車・交通のレシートもある。用途に合うデータと用途外のデータを含む小規模評価であり、飲み会のレシート全般を代表する精度とは扱わない。合成データの成績を実写精度として表示しない。

JaWildText の著者は Koki Maeda / Naoaki Okazaki。利用時は [JaWildText 論文](https://arxiv.org/abs/2603.27942)を参照する。JOMB は K10124 配布の Japan OCR Mini Benchmark として出典を記載する。ライセンスを伴う原本データをアプリへ同梱しない。

## Manifest と正解の変換

出力は `jawildtext/manifest.json` と `jomb-alpha10/manifest.json`。`image` と `groundTruth` はそれぞれの manifest からの相対パス。

```json
{
  "dataset": "llm-jp/jawildtext/receipt_kie",
  "revision": "627ca7ea7c224ffe1accff8737991fc2240784fa",
  "license": "Apache-2.0",
  "synthetic": false,
  "fixtures": [
    {
      "id": "jawildtext-1",
      "image": "images/0001.jpg",
      "split": "dev",
      "expected": {
        "total": 2320,
        "items": [
          { "name": "とろすた 五分目", "amount": 1130, "quantity": 1 },
          { "name": "肉そば1.5", "amount": 1190, "quantity": 1 }
        ]
      }
    }
  ]
}
```

この例では説明を短くするため出典・ハッシュ・除外件数を省略している。実ファイルにはすべて含む。

- `amount` は印字された行金額。数量を掛け直さない。JOMB の `unit_price_yen` は評価の行金額に使わない。
- `total` は正解の支払い総額。明細から計算し直さない。内税を二重加算せず、外税・値引きを無視して明細合計を総額にしない。
- 数量が null または空欄のときのみ 1 とする。`excluded.defaultedQuantities` に件数を残し、印字された数量の正答率とは区別する。値があるが読めない数量は推測しない。
- 商品名は NFKC と前後の空白除去だけを行う。商品コードの削除や同義語への置換をしない。明細の並びは GT の並びを保つため、評価側は順不同で照合する。
- `¥3.890` は 3 桁区切りとして 3890 円に変換する。小数形式や不正な区切りは受け入れない。通貨記号、末尾の「円」、全角数字、カンマ区切りを正規化する。
- 0 円のオプション行は `zeroAmountItems`、負の割引行は `negativeAmountItems` に数を残して品目評価から除外する。総額はそのまま保持する。
- 商品名・金額・数量が読めない明細があれば、その画像全体を評価から除外する。不完全な GT と照合して正しい予測を誤検出扱いしない。元 GT は削除しない。
- 画像を縮小・補正しない。評価用の前処理は `scripts/receipt-eval/` 側で行い、元画像ハッシュと区別する。

## 比較した別候補

- [Japanese-Mobile-Receipt-OCR-1.3K の著者モデル](https://huggingface.co/sabaridsnfuji/Japanese-Receipt-VL-3B-JSON): 実レシートを使った Qwen2.5-VL の LoRA 微調整。論文の 1,300 枚とモデルカードの 1,147 枚という版の差があり、画像と GT を直接取得できる公開データ配布先・データライセンスは今回確認できなかった。モデルの Apache 表示を画像利用許諾に流用しない。
- [CORD](https://github.com/clovaai/cord): インドネシアの実レシート。公開は 1,000 例で、明細・数量・単価・割引・税・合計の詳細注釈があり CC BY 4.0。明細抽出の構造を調べる参考に適するが、日本語の認識精度の評価には使わない。NAVER の[配布元](https://huggingface.co/datasets/naver-clova-ix/cord-v2)を確認した。
- [SROIE の主催者論文](https://arxiv.org/abs/2103.10213): 約 1,000 枚のスキャン画像。主要な構造抽出対象は店名・住所・日付・合計で、商品と数量の明細評価には不足。今回は主催者のダウンロードページへの接続が不安定で、原配布条件を直接確認できず、取得対象から外した。
- [Aulvem 日本語証憑抽出評価](https://huggingface.co/datasets/Aulvem/japanese-invoice-receipt-extraction-eval): 合成テキスト 45 件、うち領収書 10 件。画像は含まず CC BY-NC 4.0。画像 OCR の評価対象から外した。
