// @vitest-environment happy-dom
// SIMILAR-NOTICE-001 (owner, 2026-11-20): "find similar songs needs a pop up or indicator on how many new similar
// songs it found and added".
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { similarDetail, SimilarNotice } from './SimilarNotice';

afterEach(cleanup);
const card = () => screen.getByRole('status', { name: 'Find similar songs' });

describe('the Find similar card', () => {
  it('while it looks, says for which song and what it is doing, with nothing to press', () => {
    render(<SimilarNotice note={{ phase: 'busy', title: 'Nights', progress: 'Comparing song 22 of 61' }} onClose={vi.fn()} />);
    expect(card().textContent).toContain('Finding songs like “Nights”');
    expect(card().textContent).toContain('Comparing song 22 of 61');
    expect(card().querySelectorAll('button')).toHaveLength(0);
  });
  it('when done, leads with how many new songs were added, and where', () => {
    render(<SimilarNotice note={{ phase: 'done', title: 'Nights', added: 7, detail: '7 at 65% sound match or more' }} onShow={vi.fn()} onClose={vi.fn()} />);
    expect(card().textContent).toContain('+7');
    expect(card().textContent).toContain('7 new similar songs added');
    expect(card().textContent).toContain('to your Now playing queue, like “Nights”');
    expect(card().textContent).toContain('65% sound match');
  });
  it('one song is "1 new similar song"', () => {
    render(<SimilarNotice note={{ phase: 'done', title: 'X', added: 1, detail: '' }} onClose={vi.fn()} />);
    expect(card().textContent).toContain('1 new similar song added');
  });
  it('Show goes to the songs; Close closes', () => {
    const onShow = vi.fn(), onClose = vi.fn();
    render(<SimilarNotice note={{ phase: 'done', title: 'X', added: 3, detail: '' }} onShow={onShow} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show the 3 new similar songs in the Now playing queue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onShow).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it('says plainly when nothing new was found, and why', () => {
    render(<SimilarNotice note={{ phase: 'none', title: 'X', detail: 'No new songs reached 70% sound match. The list is unchanged.' }} onClose={vi.fn()} />);
    expect(card().textContent).toContain('No new similar songs found');
    expect(card().textContent).toContain('The list is unchanged');
    expect(screen.queryByRole('button', { name: /^Show/ })).toBeNull();
  });
  it('names each kind of match it added', () => {
    expect(similarDetail({ added: 3, reached: 1, below: 2, minimum: 70 })).toBe('1 at 70% sound match or more · 2 closest below 70%');
    expect(similarDetail({ added: 4, reached: 0, unmeasured: 4, minimum: 70 })).toBe('4 related, sound not compared');
    // Measured on Windows: "3 new similar songs added … · 3 at 65% sound match or more" said the 3 twice.
    expect(similarDetail({ added: 3, reached: 3, minimum: 65 })).toBe('at least 65% sound match');
  });
});
