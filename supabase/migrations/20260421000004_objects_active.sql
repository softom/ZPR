-- Поле активности объекта (soft delete)
alter table objects add column active boolean not null default true;

comment on column objects.active is 'false = объект деактивирован. Из БД не удаляется — хранится для истории связей';

create index on objects (active);
