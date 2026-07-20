// Mapeia nomes de tool do Claude pra ícones lucide-react. Usado tanto no
// accordion do MessageList quanto na "constelação" de tools do modo Jarvis.
import {
  Wrench, FileText, Pencil, FilePlus, Search, FolderSearch, Terminal,
  Globe, Download, Brain, Music4, ListTodo, GitBranch, Clock, Bug, Bot,
  Workflow as WorkflowIcon, Database, Calendar, KeyRound, BookOpen,
} from 'lucide-react';
import type { ComponentType } from 'react';

type IconC = ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;

// Categoriza pelo prefixo/keyword no nome — funciona pros built-ins do Claude
// e pros MCP tools (que têm prefixo mcp__).
export function iconForTool(name: string | undefined): IconC {
  const n = String(name || '').toLowerCase();
  if (n.includes('read') || n.includes('view')) return FileText;
  if (n.includes('write') || n.includes('create')) return FilePlus;
  if (n.includes('edit') || n.includes('replace')) return Pencil;
  if (n.includes('glob')) return FolderSearch;
  if (n.includes('grep') || n.includes('search')) return Search;
  if (n.includes('bash') || n.includes('shell') || n.includes('terminal') || n.includes('powershell')) return Terminal;
  if (n.includes('webfetch') || n.includes('fetch') || n === 'webfetch' || n.includes('http')) return Download;
  if (n.includes('websearch') || n.includes('search')) return Globe;
  if (n.includes('think')) return Brain;
  if (n.includes('orchestrate') || n.includes('dispatch') || n.includes('maestrus')) return Music4;
  if (n.includes('task')) return ListTodo;
  if (n.includes('agent') || n.includes('subagent')) return Bot;
  if (n.includes('workflow')) return WorkflowIcon;
  if (n.includes('git') || n.includes('branch') || n.includes('commit')) return GitBranch;
  if (n.includes('schedule') || n.includes('cron') || n.includes('wakeup')) return Clock;
  if (n.includes('debug') || n.includes('lint')) return Bug;
  if (n.includes('db') || n.includes('sql') || n.includes('supabase')) return Database;
  if (n.includes('calendar')) return Calendar;
  if (n.includes('auth') || n.includes('credential') || n.includes('login')) return KeyRound;
  if (n.includes('notebook') || n.includes('docs') || n.includes('mcp_resource')) return BookOpen;
  return Wrench;
}

// Label curta e amigável (esconde prefixos MCP feios).
export function labelForTool(name: string | undefined): string {
  const n = String(name || '');
  if (!n) return 'tool';
  // mcp__claude_ai_GoDaddy__domains_check_availability → domains check availability
  const stripped = n.replace(/^mcp__[^_]+(?:_[a-zA-Z0-9]+)*__/, '');
  return stripped.replace(/_/g, ' ');
}
