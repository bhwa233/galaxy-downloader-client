import { createContext, useContext } from 'react'
import zh from '@/lib/i18n/dictionaries/zh.json'
import zhTW from '@/lib/i18n/dictionaries/zh-tw.json'
import en from '@/lib/i18n/dictionaries/en.json'
import ja from '@/lib/i18n/dictionaries/ja.json'
export const dictionaries = { zh, 'zh-tw': zhTW, en, ja }
export const DictionaryContext = createContext(dictionaries.zh)
export function useDictionary() { return useContext(DictionaryContext) }
