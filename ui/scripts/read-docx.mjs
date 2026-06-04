import mammoth from 'mammoth'
const path = process.argv[2]
const r = await mammoth.extractRawText({ path })
console.log(r.value)
