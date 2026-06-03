"use client";

import { useRef } from "react";
import { Search, RefreshCw, Zap } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface HeaderProps {
  query?: string;
  onSearch?: (query: string) => void;
  onRefresh?: () => void;
  platform?: string;
  onPlatformChange?: (platform: string) => void;
}

export function Header({
  query = "",
  onSearch,
  onRefresh,
  platform = "all",
  onPlatformChange,
}: HeaderProps) {
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSearch = (value: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onSearch?.(value), 300);
  };

  return (
    <header className="h-16 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-md sticky top-0 z-30 px-6 flex items-center justify-between">
      <div className="flex items-center gap-4 flex-1">
        <div className="flex items-center mr-4">
          <Zap className="w-5 h-5 text-blue-500 mr-2" />
          <span className="font-semibold text-lg tracking-tight">ViralScope</span>
        </div>

        <Select value={platform} onValueChange={(val) => val && onPlatformChange?.(val)}>
          <SelectTrigger className="w-[160px] h-9 bg-zinc-900 border-zinc-800 text-sm">
            <SelectValue placeholder="All Platforms" />
          </SelectTrigger>
          <SelectContent className="bg-zinc-900 border-zinc-800 text-zinc-100">
            {/* Use "all" — matches the API route's default check (platform !== 'all') */}
            <SelectItem value="all">All Platforms</SelectItem>
            <SelectItem value="YouTube_Shorts">YouTube Shorts</SelectItem>
            <SelectItem value="TikTok">TikTok</SelectItem>
            <SelectItem value="Instagram_Reels">Instagram Reels</SelectItem>
          </SelectContent>
        </Select>

        <div className="relative w-64">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-zinc-500" />
          {/*
            Uncontrolled input with a `key` prop: lets the user type freely
            (no re-render per keystroke) but re-mounts when `query` is cleared
            externally (e.g. the user hits the refresh button or navigates).
          */}
          <Input
            key={query}
            defaultValue={query}
            placeholder="Search ID, tag, keyword..."
            className="pl-9 bg-zinc-900 border-zinc-800 text-sm focus-visible:ring-1 focus-visible:ring-zinc-700 h-9"
            onChange={(e) => handleSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          className="h-9 bg-transparent border-zinc-800 hover:bg-zinc-800 hover:text-zinc-100"
          onClick={onRefresh}
        >
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      </div>
    </header>
  );
}
