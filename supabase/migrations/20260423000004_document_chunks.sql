-- Векторный индекс документов (pgvector)
create extension if not exists vector;

create table if not exists document_chunks (
    id           uuid primary key default gen_random_uuid(),
    document_id  uuid not null references documents(id) on delete cascade,
    chunk_index  int  not null,
    chunk_text   text not null,
    embedding    vector(1536),
    created_at   timestamptz not null default now()
);

comment on table document_chunks is 'Чанки текста документов с эмбеддингами для семантического поиска';

create index if not exists document_chunks_doc_idx on document_chunks (document_id);
create index if not exists document_chunks_emb_idx on document_chunks
    using ivfflat (embedding vector_cosine_ops) with (lists = 50);

-- RLS
alter table document_chunks enable row level security;
create policy "dev_all" on document_chunks for all using (true);

-- RPC-функция для семантического поиска
create or replace function search_documents(query_embedding vector(1536), match_count int default 10)
returns table (
    document_id  uuid,
    chunk_text   text,
    similarity   float,
    title        text,
    folder_path  text,
    object_codes jsonb
)
language sql stable as $$
    select
        dc.document_id,
        dc.chunk_text,
        1 - (dc.embedding <=> query_embedding) as similarity,
        d.title,
        d.folder_path,
        d.object_codes
    from document_chunks dc
    join documents d on d.id = dc.document_id
    where d.deleted_at is null
    order by dc.embedding <=> query_embedding
    limit match_count;
$$;
