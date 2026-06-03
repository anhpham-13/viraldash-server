"use client";

import { useState } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ArrowUpDown } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

interface ViralTableProps {
  videos: any[];
  total: number;
  page: number;
  limit: number;
  platform?: string;
  onPageChange: (page: number) => void;
  onLimitChange: (limit: number) => void;
  onSortChange: (key: string) => void;
  onPlatformChange?: (platform: string) => void;
  onRowClick: (video: any) => void;
}

export function ViralTable({ videos, total, page, limit, platform, onPageChange, onLimitChange, onSortChange, onPlatformChange, onRowClick }: ViralTableProps) {
  const totalPages = Math.ceil(total / limit);

  const handlePageChange = (newPage: number) => {
    onPageChange(newPage);
    document.getElementById('main-scroll-area')?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const formatNumber = (n: number) => {
    if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(2) + 'K';
    return Number.isInteger(n) ? n.toString() : n.toFixed(2);
  };

  const formatAge = (hours: number) => {
    if (hours == null) return '—';
    if (hours < 1) {
      return `${Math.round(hours * 60)}m`;
    }
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  };

  const renderStatus = (status: string) => {
    switch (status) {
      case 'Viral': return <Badge className="bg-rose-500/20 text-rose-500 border-rose-500/30">Viral</Badge>;
      case 'Trending': return <Badge className="bg-amber-500/20 text-amber-500 border-amber-500/30">Trending</Badge>;
      case 'Declining': return <Badge className="bg-zinc-500/20 text-zinc-400 border-zinc-500/30">Declining</Badge>;
      default: return <Badge className="bg-emerald-500/20 text-emerald-500 border-emerald-500/30">Emerging</Badge>;
    }
  };

  return (
    <div className="flex flex-col bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <Table className="table-fixed min-w-[70rem]">
          <TableHeader className="bg-zinc-900 border-b border-zinc-800">
            <TableRow className="hover:bg-transparent border-zinc-800">
              <TableHead className="w-[4rem] min-w-[4rem] max-w-[4rem]">Rank</TableHead>
              <TableHead className="w-[12rem] min-w-[12rem] max-w-[12rem]">Video ID</TableHead>
              <TableHead className="w-[8rem] min-w-[8rem] max-w-[8rem]">Platform</TableHead>
              <TableHead className="w-[7rem] min-w-[7rem] max-w-[7rem] cursor-pointer hover:text-zinc-100" onClick={() => onSortChange('age_hours')}>
                Age <ArrowUpDown className="inline w-3 h-3 ml-1" />
              </TableHead>
              <TableHead className="w-[8rem] min-w-[8rem] max-w-[8rem] text-right cursor-pointer hover:text-zinc-100" onClick={() => onSortChange('view_count')}>
                Views <ArrowUpDown className="inline w-3 h-3 ml-1" />
              </TableHead>
              <TableHead className="w-[7rem] min-w-[7rem] max-w-[7rem] text-right cursor-pointer hover:text-zinc-100" onClick={() => onSortChange('engagement_score')}>
                ER % <ArrowUpDown className="inline w-3 h-3 ml-1" />
              </TableHead>
              <TableHead className="w-[9rem] min-w-[9rem] max-w-[9rem] text-right cursor-pointer hover:text-zinc-100" onClick={() => onSortChange('viral_velocity')}>
                Velocity <ArrowUpDown className="inline w-3 h-3 ml-1" />
              </TableHead>
              <TableHead className="w-[8rem] min-w-[8rem] max-w-[8rem] text-right cursor-pointer hover:text-zinc-100" onClick={() => onSortChange('viral_score')}>
                Score <ArrowUpDown className="inline w-3 h-3 ml-1" />
              </TableHead>
              <TableHead className="w-[6rem] min-w-[6rem] max-w-[6rem] text-center">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {videos.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="h-24 text-center text-zinc-500">No videos found.</TableCell>
              </TableRow>
            ) : (
              videos.map((v, i) => (
                <TableRow 
                  key={v.video_id || i} 
                  className="hover:bg-zinc-800/50 cursor-pointer border-zinc-800 transition-colors"
                  onDoubleClick={() => onRowClick(v)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (v.url) {
                      window.open(v.url, '_blank');
                    }
                  }}
                >
                  <TableCell className="font-mono text-zinc-500 w-[4rem] min-w-[4rem] max-w-[4rem] truncate">#{(page - 1) * limit + i + 1}</TableCell>
                  <TableCell className="font-mono text-sm w-[12rem] min-w-[12rem] max-w-[12rem] truncate">{v.video_id}</TableCell>
                  <TableCell className="w-[8rem] min-w-[8rem] max-w-[8rem] truncate">
                    <span className="text-[10px] uppercase tracking-wider bg-zinc-800 px-2 py-1 rounded text-zinc-300">
                      {v.platform?.replace('_', ' ')}
                    </span>
                  </TableCell>
                  <TableCell className="text-zinc-400 text-sm w-[7rem] min-w-[7rem] max-w-[7rem] truncate">
                    {formatAge(v.age_hours)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm w-[8rem] min-w-[8rem] max-w-[8rem] truncate">{formatNumber(v.view_count || 0)}</TableCell>
                  <TableCell className="text-right font-mono text-sm text-blue-400 w-[7rem] min-w-[7rem] max-w-[7rem] truncate">{(v.engagement_score || 0).toFixed(2)}%</TableCell>
                  <TableCell className="text-right font-mono text-sm w-[9rem] min-w-[9rem] max-w-[9rem] truncate">{formatNumber(v.viral_velocity || 0)} v/h</TableCell>
                  <TableCell className="text-right font-bold text-emerald-400 w-[8rem] min-w-[8rem] max-w-[8rem] truncate">{typeof v.viral_score === 'number' && !Number.isInteger(v.viral_score) ? (v.viral_score || 0).toFixed(2) : (v.viral_score || 0)}</TableCell>
                  <TableCell className="text-center w-[6rem] min-w-[6rem] max-w-[6rem] truncate">{renderStatus(v.status)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination Controls */}
      <div className="flex items-center justify-between px-4 py-3 border-t border-zinc-800 bg-zinc-950/50">
        <div className="flex items-center space-x-2">
          <p className="text-sm text-zinc-400">
            Showing <span className="font-medium text-zinc-200">{(page - 1) * limit + (videos.length > 0 ? 1 : 0)}</span> to{" "}
            <span className="font-medium text-zinc-200">{(page - 1) * limit + videos.length}</span> of{" "}
            <span className="font-medium text-zinc-200">{total}</span> videos
          </p>
        </div>
        <div className="flex items-center space-x-6 lg:space-x-8">
          <div className="flex items-center space-x-2">
            <p className="text-sm font-medium text-zinc-400">Rows per page</p>
            <select
              className="h-8 w-[70px] rounded-md border border-zinc-800 bg-zinc-900 text-sm"
              value={limit}
              onChange={(e) => onLimitChange(Number(e.target.value))}
            >
              {[10, 25, 50, 100].map((pageSize) => (
                <option key={pageSize} value={pageSize}>
                  {pageSize}
                </option>
              ))}
            </select>
          </div>
          <div className="flex w-[100px] items-center justify-center text-sm font-medium text-zinc-400">
            Page {page} of {totalPages || 1}
          </div>
          <div className="flex items-center space-x-2">
            <Button
              variant="outline"
              className="hidden h-8 w-8 p-0 lg:flex bg-zinc-900 border-zinc-800"
              onClick={() => handlePageChange(1)}
              disabled={page <= 1}
            >
              <ChevronsLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              className="h-8 w-8 p-0 bg-zinc-900 border-zinc-800"
              onClick={() => handlePageChange(page - 1)}
              disabled={page <= 1}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              className="h-8 w-8 p-0 bg-zinc-900 border-zinc-800"
              onClick={() => handlePageChange(page + 1)}
              disabled={page >= totalPages}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              className="hidden h-8 w-8 p-0 lg:flex bg-zinc-900 border-zinc-800"
              onClick={() => handlePageChange(totalPages)}
              disabled={page >= totalPages}
            >
              <ChevronsRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
