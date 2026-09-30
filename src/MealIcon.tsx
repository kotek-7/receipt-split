import { Beer, GlassWater, Utensils, Wine } from 'lucide-react';

export default function MealIcon({
  name,
  size = 26,
  strokeWidth = 1.7,
}: {
  name: string;
  size?: number;
  strokeWidth?: number;
}) {
  const Icon = /ビール|ビア|発泡酒|生中|生大|生小|beer/i.test(name)
    ? Beer
    : /ワイン|シャンパン|スパークリング|wine/i.test(name)
      ? Wine
      : /ハイボール|サワー|チューハイ|焼酎|日本酒|ウイスキー|カクテル|梅酒|ジュース|コーラ|ソーダ|茶$|コーヒー|炭酸水|ウォーター|^お?水$|ドリンク/i.test(
            name,
          )
        ? GlassWater
        : Utensils;

  return <Icon size={size} strokeWidth={strokeWidth} aria-hidden="true" />;
}
