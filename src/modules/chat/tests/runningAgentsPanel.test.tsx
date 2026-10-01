import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

import '@/modules/i18n';
import { RunningAgentsPanel } from '@/modules/chat/transcript/RunningAgentsPanel';
import type { ChatMessage } from '@/shared/types';

const agentRow = (overrides: Partial<ChatMessage>): ChatMessage => ({
  type: 'assistant',
  content: '',
  timestamp: '2026-10-01T10:00:00.000Z',
  isToolUse: true,
  toolName: 'Agent',
  isSubagentContainer: true,
  ...overrides,
});

describe('the running agents panel', () => {
  it('renders nothing while no agent is running', () => {
    const { container } = render(
      <RunningAgentsPanel
        sessionId="session-1"
        createDiff={() => []}
        sendMessage={() => {}}
        onReveal={() => {}}
        messages={[
          agentRow({ toolId: 'toolu_done', toolResult: { content: 'done', isError: false } }),
        ]}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('lists each running agent with what it is doing right now', () => {
    render(
      <RunningAgentsPanel
        sessionId="session-1"
        createDiff={() => []}
        sendMessage={() => {}}
        onReveal={() => {}}
        messages={[
          agentRow({
            toolId: 'toolu_agent_1',
            subagent: { id: 'a1', type: 'general-purpose', description: 'Backend lot L12', status: 'running' },
            subagentActivity: [
              { kind: 'tool', toolId: 't1', toolName: 'Read', toolInput: JSON.stringify({ file_path: '/src/a.py' }) },
              { kind: 'tool', toolId: 't2', toolName: 'Bash', toolInput: JSON.stringify({ command: 'npm test' }) },
            ],
          }),
        ]}
      />,
    );

    expect(screen.getByText('1 agent running')).toBeTruthy();
    expect(screen.getByText('general-purpose')).toBeTruthy();
    expect(screen.getByText('Backend lot L12')).toBeTruthy();
    expect(screen.getByText('Bash npm test')).toBeTruthy();
    expect(screen.getByText(/2 tools/)).toBeTruthy();
  });

  it('keeps an agent listed, dimmed, once it has finished after being seen running', () => {
    const noop = () => {};
    const running = agentRow({
      toolId: 'toolu_agent_1',
      subagent: { id: 'a1', type: 'Explore', description: 'Survey the repo', status: 'running' },
    });
    const { rerender } = render(
      <RunningAgentsPanel sessionId="s" createDiff={() => []} sendMessage={noop} onReveal={noop} messages={[running]} />,
    );
    expect(screen.getByText('1 agent running')).toBeTruthy();

    const finished = { ...running, subagent: { ...running.subagent!, status: 'completed' as const } };
    rerender(<RunningAgentsPanel sessionId="s" createDiff={() => []} sendMessage={noop} onReveal={noop} messages={[finished]} />);
    expect(screen.getByText('1 agent finished')).toBeTruthy();
    expect(screen.getByText('Survey the repo')).toBeTruthy();
  });

  it('keeps at most five finished agents and drops the oldest', () => {
    const noop = () => {};
    const make = (status: 'running' | 'completed') =>
      Array.from({ length: 7 }, (_, index) => agentRow({
        toolId: `toolu_${index}`,
        subagent: { id: `a${index}`, type: 'general-purpose', description: `job ${index}`, status },
      }));
    const { rerender } = render(
      <RunningAgentsPanel sessionId="s" createDiff={() => []} sendMessage={noop} onReveal={noop} messages={make('running')} />,
    );
    rerender(<RunningAgentsPanel sessionId="s" createDiff={() => []} sendMessage={noop} onReveal={noop} messages={make('completed')} />);

    expect(screen.getByText('5 agents finished')).toBeTruthy();
    expect(screen.queryByText('job 0')).toBeNull();
    expect(screen.queryByText('job 1')).toBeNull();
    expect(screen.getByText('job 6')).toBeTruthy();
  });

  it('never lists a finished agent it did not see running, e.g. from loaded history', () => {
    const { container } = render(
      <RunningAgentsPanel
        sessionId="s"
        createDiff={() => []}
        sendMessage={() => {}}
        onReveal={() => {}}
        messages={[agentRow({ toolId: 'toolu_old', subagent: { id: 'a', description: 'old', status: 'completed' } })]}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('clears the finished agents from its cross', () => {
    const noop = () => {};
    const running = agentRow({ toolId: 'toolu_1', subagent: { id: 'a', description: 'job', status: 'running' } });
    const { container, rerender } = render(
      <RunningAgentsPanel sessionId="s" createDiff={() => []} sendMessage={noop} onReveal={noop} messages={[running]} />,
    );
    rerender(
      <RunningAgentsPanel
        sessionId="s"
        createDiff={() => []}
        sendMessage={noop}
        onReveal={noop}
        messages={[{ ...running, subagent: { ...running.subagent!, status: 'completed' as const } }]}
      />,
    );
    fireEvent.click(screen.getByLabelText('Clear finished agents'));
    expect(container.firstChild).toBeNull();
  });

  it('opens the agent transcript in a drawer on click, and can locate the block or close', () => {
    const onReveal = vi.fn();
    const row = agentRow({
      toolId: 'toolu_agent_1',
      toolInput: JSON.stringify({ prompt: 'Survey every module' }),
      subagent: { id: 'a1', type: 'Explore', description: 'Survey the repo', status: 'running' },
    });
    render(
      <RunningAgentsPanel sessionId="session-1" createDiff={() => []} sendMessage={() => {}} onReveal={onReveal} messages={[row]} />,
    );

    fireEvent.click(screen.getByText('Survey the repo'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Survey every module')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Show in conversation'));
    expect(onReveal).toHaveBeenCalledWith(row);
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByText('Survey the repo'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('stops a background agent from its cross', () => {
    const sendMessage = vi.fn();
    const row = agentRow({
      toolId: 'toolu_agent_1',
      taskStatus: { status: 'running', taskId: 'task-9', description: 'Survey the repo' },
    });
    render(
      <RunningAgentsPanel sessionId="session-1" createDiff={() => []} sendMessage={sendMessage} onReveal={() => {}} messages={[row]} />,
    );

    fireEvent.click(screen.getByLabelText('Stop'));
    expect(sendMessage).toHaveBeenCalledWith({ type: 'chat.stop-task', sessionId: 'session-1', taskId: 'task-9' });
  });
});
