import type { ParsedReceipt, ReceiptItem } from './types.ts';
import { createItemId } from './id.ts';

const TOTAL =
  /^(?:(?:ご|お)?(?:請求|支払い?|会計)(?:金額|額|合計)?|(?:お買上げ?|お買い上げ)(?:金額|合計)|(?:税込み?|総)?合計(?:金額)?|現計|総額|grandtotal|total|amountdue)(?:[:：\s]|[¥\\\d]|$)/i;
const DISCOUNT = /値引|割引|クーポン|サービス値引|discount|coupon/i;
const METADATA =
  /小計|消費税|税額|内税|外税|税抜|税率|課税|対象|預[かり]*|釣[り銭]*|現金|クレジット|カード|電子マネー|ポイント|残高|支払方法|領収|レシート|レジ(?!袋)|担当|責任者|取引|伝票|注文番号|受付|登録番号|会員|電話|住所|営業時間|お客様|お客さま|ご利用|ありがとうございました|またの|subtotal|tax|cash|change|visa|mastercard|amex|tel|fax|www\.|https?:|receipt|thank\s*you|balance|payment|auth|invoice/i;
const MAX_AMOUNT = 10_000_000;

function normalize(line: string): string {
  return line
    .normalize('NFKC')
    .replace(/[−﹣–—]/g, '-')
    .replace(/[▲△]/g, '-')
    .replace(/[\t\u00a0]+/g, ' ')
    .trim();
}

function compact(line: string): string {
  return line.replace(/\s+/g, '');
}

function isMetadata(line: string): boolean {
  const value = compact(line);
  return (
    METADATA.test(value) ||
    /(?:\d{2,4}[年/.-]\d{1,2}[月/.-]\d{1,2}|\d{1,2}:\d{2}|\d{2,4}-\d{2,4}-\d{3,4})/.test(value) ||
    /^(?:〒|T\d{13}|[A-Z]?\d{8,}|[*Xx●]{3,})/.test(value) ||
    /(?:都|道|府|県|市|区|町|丁目).*(?:\d+-\d+|\d+番)/.test(value) ||
    /^(?:数量|点数|商品数|合計点数|人数|客数|人数計|単価|金額|品名|商品名)/.test(value) ||
    /^\(?\d+(?:\.\d+)?%/.test(value) ||
    /^(?:[*※-]|={2,}|_{2,})+$/.test(value)
  );
}

function isTotal(line: string): boolean {
  return TOTAL.test(line) || TOTAL.test(compact(line));
}

function isTotalLabel(line: string): boolean {
  const value = compact(line);
  return TOTAL.exec(value)?.[0] === value;
}

/** Read the last price column, leaving earlier quantity/unit-price columns in the label. */
function priceAtEnd(line: string): { label: string; amount: number } | null {
  const value = line
    // OCR may omit the crossbars of a yen sign. Only accept a separate final price token.
    .replace(/(^|\s)[Yy](?=\s*-?\d+(?:\s*,\s*\d+)*(?:\s*円)?\s*$)/, '$1¥')
    .replace(/-\s*([¥￥\\])/g, '$1-')
    .replace(/-\s+(?=\d)/g, '-')
    .replace(/\s*(?:\((?:税込|税別|内税|外税)\)|税込|税別)\s*$/, '')
    .replace(/\s*[*※軽内外]+\s*$/, '');
  // Japanese yen glyphs are also commonly transcribed as a backslash by OCR.
  // Only treat it as currency immediately before the final amount, never in names.
  const match = value.match(/(?:[¥￥\\]\s*)?(-?\d+(?:\s*,\s*\d+)*)(?:\s*円)?\s*$/);
  if (!match || match.index === undefined) return null;
  const number = match[1].replace(/[\s,]/g, '');
  const amount = Number(number);
  if (!Number.isSafeInteger(amount) || Math.abs(amount) > MAX_AMOUNT) return null;
  const rawLabel = value.slice(0, match.index);
  const label = rawLabel.trim();
  // Decimal prices, percentages, dates, and phone fragments are not yen prices.
  if (
    /[\d.,:/%-]$/.test(rawLabel) ||
    /[.,:/%-]$/.test(rawLabel.trimEnd()) ||
    /[%％]/.test(value.slice(match.index))
  )
    return null;
  // A size or model number at the end of a product name is not a price column.
  if (
    label &&
    !/\s$/.test(rawLabel) &&
    !/^[¥￥\\]|円\s*$/.test(match[0]) &&
    !isTotalLabel(label) &&
    !DISCOUNT.test(label)
  )
    return null;
  return { label, amount };
}

function cleanName(name: string): string {
  return name
    .replace(/^(?:[*※・#]+\s*|[AB](?:\s+|(?=#)))+/, '')
    .replace(/\s+[¥￥]?\d[\d,]*\s*[×xX]\s*\d+\s*$/, '')
    .replace(
      /\s+\d+\s*(?:コ|個|点|皿|本|杯|人前)\s*(?:[×xXメ]\s*)+(?:単\s*価?\s*)?[¥￥\\]?\s*\d+(?:\s*,\s*\d+)*(?:\s*円)?\s*$/,
      '',
    )
    .replace(/\s+(?:[×xX]\s*\d+|\d+\s*(?:点|個|皿|本|杯|人前|コ))\s*$/, '')
    .replace(/\s*[:：]\s*$/, '')
    .trim();
}

type QuantityPrice = { calculated?: number; explicit?: number };

/** A supermarket often prints the quantity, unit price, and row total below its name. */
function quantityPrice(line: string): QuantityPrice | null {
  const prefix = line.match(
    /^(\d+)\s*(?:コ|個|点|皿|本|杯|人前)\s*(?:(?:[×xXメ]\s*)+(?:(?:単\s*価?|B)\s*[:：]?\s*)?|単\s*価?\s*[:：]?\s*)/,
  );
  if (!prefix) return null;
  const rest = line.slice(prefix[0].length).trim();
  if (!rest) return {};
  const unit = rest.match(/^(?:[¥￥\\]\s*)?(\d+(?:\s*,\s*\d+)*)(?:\s*円)?/);
  if (!unit) return null;
  const remainder = rest.slice(unit[0].length);
  // Keep adjacent digits as one unit price. A second number needs a column boundary.
  if (remainder && !/^(?:\s|[¥￥\\])/.test(remainder)) return null;
  const row = remainder.trim() ? priceAtEnd(remainder.trim()) : undefined;
  if (remainder.trim() && (!row || row.label || row.amount < 0)) return null;
  const calculated = Number(prefix[1]) * Number(unit[1].replace(/[\s,]/g, ''));
  return {
    calculated:
      Number(prefix[1]) > 0 && Number.isSafeInteger(calculated) && calculated <= MAX_AMOUNT
        ? calculated
        : undefined,
    explicit: row?.amount,
  };
}

function isQuantityLine(line: string): boolean {
  return /^(?:[×xX]\s*\d+|\d+\s*(?:点|個|皿|本|杯|人前|コ)|(?:数量|単価)\s*[:：]?\s*\d+)$/.test(
    line,
  );
}

/** OCR is fallible: this parser returns an editable draft, never a confirmed bill. */
export function parseReceipt(text: string): ParsedReceipt {
  const lines = text.split(/\r?\n/).map(normalize).filter(Boolean);
  const items: ReceiptItem[] = [];
  let total: number | undefined;
  let discounts = 0;
  let pending: string | undefined;
  let pendingUnitTotal: number | undefined;
  let title = 'レシートの精算';
  let finishedItems = false;

  const addItem = (label: string, amount: number) => {
    const name = cleanName(label);
    if (name && !isMetadata(name) && !/^\d+$/.test(name) && !isQuantityLine(name)) {
      items.push({ id: createItemId(), name, amount });
    }
  };
  const finishQuantityItem = () => {
    if (pending && pendingUnitTotal !== undefined) addItem(pending, pendingUnitTotal);
    pending = undefined;
    pendingUnitTotal = undefined;
  };

  for (const line of lines) {
    const price = priceAtEnd(line);
    const quantity = quantityPrice(line);
    if (quantity) {
      if (!finishedItems && pending && !isMetadata(pending) && !isTotal(pending)) {
        if (quantity.explicit !== undefined) {
          addItem(pending, quantity.explicit);
          pending = undefined;
          pendingUnitTotal = undefined;
        } else if (quantity.calculated !== undefined) {
          // Defer until the next line: a separately printed row total takes precedence.
          pendingUnitTotal = quantity.calculated;
        }
      }
      continue;
    }
    if (isQuantityLine(line)) continue;
    if (pendingUnitTotal !== undefined && !(price && !price.label)) finishQuantityItem();
    const label = price?.label || pending || '';

    if (isTotal(line) || (price && !price.label && pending && isTotal(pending))) {
      if (price && price.amount >= 0) {
        total = price.amount;
        finishedItems = items.length > 0;
        pending = undefined;
        pendingUnitTotal = undefined;
      } else {
        pending = line;
      }
      continue;
    }

    if (isMetadata(line)) {
      pending = undefined;
      pendingUnitTotal = undefined;
      continue;
    }
    if (finishedItems) continue;

    if (price) {
      if (DISCOUNT.test(label) || price.amount < 0) {
        discounts -= Math.abs(price.amount);
        pending = undefined;
        pendingUnitTotal = undefined;
        continue;
      }
      addItem(label, price.amount);
      pending = undefined;
      pendingUnitTotal = undefined;
    } else if (/[\p{L}]/u.test(line) && line.length <= 100) {
      pending = line;
      if (title === 'レシートの精算' && items.length === 0 && !DISCOUNT.test(line)) title = line;
    } else {
      pending = undefined;
    }
  }
  finishQuantityItem();

  return {
    items,
    total: total ?? Math.max(0, items.reduce((sum, item) => sum + item.amount, 0) + discounts),
    title,
    rawText: text,
  };
}
