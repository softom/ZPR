-- Добавить дату начала этапа в contract_milestones
alter table contract_milestones add column if not exists date_start date;
comment on column contract_milestones.date_start is 'Плановая дата начала этапа (YYYY-MM-DD)';
