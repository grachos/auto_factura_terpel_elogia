-- El producto de la observación sale de la consulta de la remesa (Home_111), tal cual: se guarda por factura y se elimina el parámetro global.
alter table invoices add column product text;
alter table invoice_settings drop column product;
