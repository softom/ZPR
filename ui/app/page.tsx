export default function Home() {
  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold text-gray-900">Добро пожаловать</h1>
      <p className="mt-2 text-gray-500">Система управления документами проекта ЗПР.</p>
      <div className="mt-8 grid grid-cols-2 gap-4">
        <a
          href="/objects"
          className="block p-5 bg-white border border-gray-200 rounded-lg hover:border-blue-400 hover:shadow-sm transition"
        >
          <p className="font-medium text-gray-900">Объекты</p>
          <p className="mt-1 text-sm text-gray-500">Реестр строительных объектов</p>
        </a>
        <a
          href="/contracts"
          className="block p-5 bg-white border border-gray-200 rounded-lg hover:border-blue-400 hover:shadow-sm transition"
        >
          <p className="font-medium text-gray-900">Договора</p>
          <p className="mt-1 text-sm text-gray-500">Загрузка и реестр договоров</p>
        </a>
        <a
          href="/incoming"
          className="block p-5 bg-white border border-gray-200 rounded-lg hover:border-blue-400 hover:shadow-sm transition"
        >
          <p className="font-medium text-gray-900">Входящие</p>
          <p className="mt-1 text-sm text-gray-500">Входящая корреспонденция</p>
        </a>
      </div>
    </div>
  )
}
