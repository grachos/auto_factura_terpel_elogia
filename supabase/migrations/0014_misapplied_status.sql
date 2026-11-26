-- Estado terminal «misapplied»: ajuste aplicado a una remesa equivocada (corrección manual solo en la BD de la app; no se revierte en Silogtran).
alter table adjustment_proposals drop constraint adjustment_proposals_status_check;
alter table adjustment_proposals add constraint adjustment_proposals_status_check check (status in (
  'proposed', 'needs_review', 'approved', 'applying', 'applied', 'simulated_applied', 'failed', 'uncertain',
  'verification_failed', 'rejected', 'stale', 'discarded', 'misapplied'));
