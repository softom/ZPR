-- Хранение сторон договора (заказчик + подрядчик с реквизитами)
alter table documents add column if not exists parties jsonb default '{}';
comment on column documents.parties is 'Стороны договора: {customer: {name, role, inn, kpp, address, signatory}, contractor: {...}}';
