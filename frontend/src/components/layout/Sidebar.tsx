import Link from "next/link";
import { LayoutDashboard, TrendingUp, Hash, Zap, Settings, HelpCircle } from "lucide-react";

export function Sidebar() {
  return (
    <div className="hidden md:flex flex-col w-64 border-r border-zinc-800 bg-zinc-950/50 backdrop-blur-sm h-screen sticky top-0">
      <div className="h-16 flex items-center px-6 border-b border-zinc-800">
        <Zap className="w-5 h-5 text-blue-500 mr-2" />
        <span className="font-semibold text-lg tracking-tight">ViralScope</span>
        <span className="ml-2 text-[10px] font-mono bg-blue-500/10 text-blue-400 px-1.5 py-0.5 rounded border border-blue-500/20">BETA</span>
      </div>
      
      <div className="flex-1 py-6 px-4 space-y-1">
        <p className="px-2 text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">Analytics</p>
        <Link href="/" className="flex items-center gap-3 px-3 py-2 rounded-md bg-zinc-800/50 text-zinc-100 transition-colors">
          <LayoutDashboard className="w-4 h-4 text-zinc-400" />
          <span className="text-sm font-medium">Dashboard</span>
        </Link>
        <Link href="#" className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-zinc-800/30 text-zinc-400 hover:text-zinc-100 transition-colors">
          <TrendingUp className="w-4 h-4" />
          <span className="text-sm font-medium">Trends</span>
        </Link>
        <Link href="#" className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-zinc-800/30 text-zinc-400 hover:text-zinc-100 transition-colors">
          <Hash className="w-4 h-4" />
          <span className="text-sm font-medium">Hashtags</span>
        </Link>
      </div>
      
      <div className="py-6 px-4 border-t border-zinc-800 space-y-1">
        <Link href="#" className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-zinc-800/30 text-zinc-400 hover:text-zinc-100 transition-colors">
          <Settings className="w-4 h-4" />
          <span className="text-sm font-medium">Settings</span>
        </Link>
        <Link href="#" className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-zinc-800/30 text-zinc-400 hover:text-zinc-100 transition-colors">
          <HelpCircle className="w-4 h-4" />
          <span className="text-sm font-medium">Support</span>
        </Link>
      </div>
    </div>
  );
}
