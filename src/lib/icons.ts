/**
 * lucide 图标白名单映射。
 * 分类数据里只存字符串键名（可被 JSON 序列化进 localStorage），
 * 渲染时通过这张表查真实组件，避免存组件导致无法持久化。
 */
import {
  Banknote,
  Bitcoin,
  Briefcase,
  Building2,
  Car,
  ChartPie,
  CircleDollarSign,
  Coins,
  CreditCard,
  Gem,
  Landmark,
  LineChart,
  PiggyBank,
  Receipt,
  Shield,
  Sparkles,
  TrendingUp,
  Wallet,
  type LucideIcon,
} from 'lucide-react'

export const ICONS: Record<string, LucideIcon> = {
  banknote: Banknote,
  bitcoin: Bitcoin,
  briefcase: Briefcase,
  building: Building2,
  car: Car,
  'chart-pie': ChartPie,
  'circle-dollar': CircleDollarSign,
  coins: Coins,
  'credit-card': CreditCard,
  gem: Gem,
  landmark: Landmark,
  'line-chart': LineChart,
  'piggy-bank': PiggyBank,
  receipt: Receipt,
  shield: Shield,
  sparkles: Sparkles,
  'trending-up': TrendingUp,
  wallet: Wallet,
}

export const ICON_NAMES = Object.keys(ICONS)

export function resolveIcon(name: string | undefined): LucideIcon {
  return (name && ICONS[name]) || Wallet
}
