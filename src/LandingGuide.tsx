import { ArrowUp, CheckCheck, Beer, Link, CookingPot, ReceiptText } from 'lucide-react';
import './landing.css';

const steps = [
  {
    icon: ReceiptText,
    title: 'レシートを確認',
    description:
      '買い出し代や居酒屋の会計を立て替えた人が開始。レシートの数量・金額と、自分を含む割り勘人数を確認します。',
  },
  {
    icon: Link,
    title: 'リンクを共有',
    description:
      '飲み会のメンバーにリンクを送ります。それぞれが名前を入力し、自分のドリンクなど、食べた・飲んだ分だけタイルを選びます。',
  },
  {
    icon: CheckCheck,
    title: '返す金額を確認',
    description:
      'みんなで分ける料理は、最初の人数で割って自動で加算。自分の入力を終えたら、ほかの人を待たずに返す金額が分かります。',
  },
];

const questions = [
  {
    title: 'お酒を飲んでいない人も、お酒代を払う？',
    answer:
      '自分のドリンクは、選んだ分だけかかります。飲んでいなければ選ばずに進めます。人数で分ける設定にしたボトルのお酒などは、全員の金額に含まれます。',
  },
  {
    title: 'ほかの人の入力で、自分の金額も変わる？',
    answer:
      '変わりません。自分のドリンクなどは1つあたりの金額、みんなで分ける料理は最初の人数で計算します。みんなで分ける料理を選ぶ操作は不要です。',
  },
  {
    title: '会員登録は必要ですか？',
    answer:
      '不要です。共有リンクを開き、名前を入力すると参加できます。続きは、参加したときと同じブラウザで開いてください。',
  },
  {
    title: 'レシートがないときや、読み取りを間違えたときは？',
    answer:
      '写真がなくても手入力で作成できます。読み取った名前・数量・金額は、共有リンクを作る前に確認して修正できます。',
  },
  {
    title: '税や値引き、割り切れない金額はどうなりますか？',
    answer:
      '入力した金額の合計と実際の会計額の差は、それぞれの料理・飲み物の金額に応じて分けます。数量や人数で割り切れない分は、立て替えた人の負担に含めます。全員の入力がそろうと、合計が会計額に一致します。',
  },
  {
    title: 'レシわけで送金できますか？',
    answer:
      '送金機能はありません。表示された金額を現金や普段使っている決済サービスで返してください。全員の入力がそろったら、立て替えた人が入力を締め切り、受け取り済みかどうかを記録できます。',
  },
  {
    title: '写真や割り勘の内容は誰に見えますか？',
    answer:
      '写真は端末内で読み取り、サーバーへ送信しません。料理・飲み物の名前や金額、参加者名などの割り勘の内容は共有用に保存され、リンクを知っている人が閲覧できます。',
  },
];

export default function LandingGuide() {
  return (
    <div className="landing-guide">
      <section className="landing-section" aria-labelledby="split-examples-title">
        <h2 id="split-examples-title">自分のドリンクも、分け合った料理も</h2>
        <p className="landing-section-intro">
          4人で飲み会。ビールを1杯飲んだら600円、みんなの唐揚げは1人300円。返す金額は900円です。
        </p>
        <div className="split-examples">
          <article className="split-example">
            <h3>
              <Beer size={22} aria-hidden="true" />
              自分のドリンク
            </h3>
            <p>自分のドリンクなどは、飲んだ数・食べた数で。</p>
            <div className="split-example-receipt">
              <div className="split-example-item">
                <span>生ビール 3杯</span>
                <strong>¥1,800</strong>
              </div>
              <p>1杯600円。飲んだ分だけタップ</p>
              <dl className="split-example-amounts">
                <div>
                  <dt>Aさん・2杯</dt>
                  <dd>¥1,200</dd>
                </div>
                <div>
                  <dt>Bさん・1杯</dt>
                  <dd>¥600</dd>
                </div>
              </dl>
            </div>
          </article>
          <article className="split-example">
            <h3>
              <CookingPot size={22} aria-hidden="true" />
              みんなの料理
            </h3>
            <p>取り分ける料理や家飲みの食材は、最初の人数で。</p>
            <div className="split-example-receipt">
              <div className="split-example-item">
                <span>唐揚げ 1皿</span>
                <strong>¥1,200</strong>
              </div>
              <p>4人なら1人300円。全員に自動で加算</p>
              <dl className="split-example-amounts">
                <div>
                  <dt>Aさん</dt>
                  <dd>¥300</dd>
                </div>
                <div>
                  <dt>Bさん</dt>
                  <dd>¥300</dd>
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
          割り勘をはじめる
          <ArrowUp size={17} aria-hidden="true" />
        </a>
      </div>
    </div>
  );
}
