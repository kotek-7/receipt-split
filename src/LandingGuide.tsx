import { ArrowUp, CheckCheck, Coffee, Link, Pizza, ReceiptText } from 'lucide-react';
import './landing.css';

const steps = [
  {
    icon: ReceiptText,
    title: 'レシートを確認',
    description:
      '立て替えた人が撮影・写真の選択・手入力から開始。品目と金額を確認し、自分を含む割り勘人数を入力します。',
  },
  {
    icon: Link,
    title: 'リンクを共有',
    description:
      '参加者はリンクを開いて名前を入力し、自分の品目や個数を選びます。立て替えた人も選択します。',
  },
  {
    icon: CheckCheck,
    title: '金額を確定',
    description:
      '全員が参加して入力を終え、すべての品目・個数の負担者が決まったら、立て替えた人が金額を確定します。',
  },
];

const questions = [
  {
    title: '会員登録は必要ですか？',
    answer:
      '不要です。共有リンクを開き、名前を入力すると参加できます。続きは、参加したときと同じブラウザで開いてください。',
  },
  {
    title: 'レシートがないときや、読み取りを間違えたときは？',
    answer:
      '写真がなくても手入力で作成できます。読み取った品目・個数・金額は、共有リンクを作る前に確認して修正できます。',
  },
  {
    title: '税や値引き、割り切れない金額はどうなりますか？',
    answer:
      '品目の合計と実際に払った総額の差は、各品目の金額に応じて配分します。端数を1円単位で調整し、すべての品目を割り当てると全員の負担額が総額に一致します。',
  },
  {
    title: 'レシわけで送金できますか？',
    answer:
      '送金機能はありません。表示された金額を現金や普段使っている決済サービスで返してください。立て替えた人は、受け取り済みかどうかを記録できます。',
  },
  {
    title: '写真や精算内容は誰に見えますか？',
    answer:
      '写真は端末内で読み取り、サーバーへ送信しません。品目・金額・参加者名などの精算内容は共有用に保存され、リンクを知っている人が閲覧できます。',
  },
];

export default function LandingGuide() {
  return (
    <div className="landing-guide">
      <section className="landing-section" aria-labelledby="split-examples-title">
        <h2 id="split-examples-title">各自のものも、シェアするものも</h2>
        <p className="landing-section-intro">
          品目ごとに分け方を選び、同じレシートでまとめて精算できます。
        </p>
        <div className="split-examples">
          <article className="split-example">
            <h3>
              <Coffee size={22} aria-hidden="true" />
              各自のもの
            </h3>
            <p>それぞれが買った個数に応じて負担します。</p>
            <div className="split-example-receipt">
              <div className="split-example-item">
                <span>コーヒー 2杯</span>
                <strong>¥1,000</strong>
              </div>
              <p>Aさんが1杯、Bさんが1杯</p>
              <dl className="split-example-amounts">
                <div>
                  <dt>Aさん</dt>
                  <dd>¥500</dd>
                </div>
                <div>
                  <dt>Bさん</dt>
                  <dd>¥500</dd>
                </div>
              </dl>
            </div>
          </article>
          <article className="split-example">
            <h3>
              <Pizza size={22} aria-hidden="true" />
              シェアするもの
            </h3>
            <p>その品目を選んだ人だけで均等に分けます。</p>
            <div className="split-example-receipt">
              <div className="split-example-item">
                <span>ピザ 1枚</span>
                <strong>¥1,600</strong>
              </div>
              <p>AさんとBさんでシェア</p>
              <dl className="split-example-amounts">
                <div>
                  <dt>Aさん</dt>
                  <dd>¥800</dd>
                </div>
                <div>
                  <dt>Bさん</dt>
                  <dd>¥800</dd>
                </div>
              </dl>
            </div>
          </article>
        </div>
      </section>

      <section className="landing-section" aria-labelledby="how-title">
        <h2 id="how-title">使い方</h2>
        <ol className="landing-steps">
          {steps.map(({ icon: Icon, title, description }, index) => (
            <li key={title}>
              <div className="landing-step-heading">
                <span className="landing-step-number" aria-hidden="true">
                  {index + 1}
                </span>
                <Icon size={24} aria-hidden="true" />
              </div>
              <h3>{title}</h3>
              <p>{description}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="landing-section landing-faq" aria-labelledby="faq-title">
        <h2 id="faq-title">よくある質問</h2>
        <div className="landing-questions">
          {questions.map(({ title, answer }) => (
            <details key={title}>
              <summary>{title}</summary>
              <p>{answer}</p>
            </details>
          ))}
        </div>
      </section>
      <div className="landing-start">
        <a href="#start" className="button primary">
          精算をはじめる
          <ArrowUp size={17} aria-hidden="true" />
        </a>
      </div>
    </div>
  );
}
