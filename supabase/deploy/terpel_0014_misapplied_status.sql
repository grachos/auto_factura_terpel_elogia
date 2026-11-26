alter table terpel.adjustment_proposals drop constraint adjustment_proposals_status_check;
alter table terpel.adjustment_proposals add constraint adjustment_proposals_status_check check (status in (
  'proposed', 'needs_review', 'approved', 'applying', 'applied', 'simulated_applied', 'failed', 'uncertain',
  'verification_failed', 'rejected', 'stale', 'discarded', 'misapplied'));
