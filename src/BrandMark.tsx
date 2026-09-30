const receiptHalves =
  'M2 2h8.5L9.25 5l1.25 3-1.25 3 1.25 3-1.25 3 1.25 3-2.75-1.5L5 20l-3-1.5V2Z ' +
  'M4 6.25h3.5v1.5H4V6.25Zm0 4h3.5v1.5H4v-1.5Zm0 4h2.5v1.5H4v-1.5Z ' +
  'M13.5 4H22v16.5L19.25 22l-2.75-1.5-3 1.5-1.25-3 1.25-3-1.25-3 1.25-3-1.25-3 1.25-3Z ' +
  'M16.5 8.25H20v1.5h-3.5v-1.5Zm0 4H20v1.5h-3.5v-1.5Zm0 4H19v1.5h-2.5v-1.5Z';

export default function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={receiptHalves} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}
