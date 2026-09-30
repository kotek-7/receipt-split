const number = (value: number) => new Intl.NumberFormat('ja-JP').format(value);

export default function AmountRatio({ amount, total }: { amount: number; total: number }) {
  return (
    <span className={`amount-ratio ${amount === 0 ? 'is-zero' : ''}`}>
      <span className="sr-only">
        負担 {number(amount)}円、全体 {number(total)}円
      </span>
      <span aria-hidden="true">
        <strong>{number(amount)}</strong>
        <span className="ratio-total"> / {number(total)}</span>
        <span className="ratio-unit"> 円</span>
      </span>
    </span>
  );
}
