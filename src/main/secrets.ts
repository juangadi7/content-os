/**
 * Claves de servicios externos. Se guardan cifradas con la protección de Windows para el usuario
 * actual (DPAPI, a través de safeStorage): el archivo no sirve en otro equipo ni con otro usuario.
 * La interfaz nunca recibe la clave de vuelta; solo sabe si existe.
 */
import { safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

const ARCHIVO = 'secrets.json'

type Almacen = Record<string, string>

function leer(configDir: string): Almacen {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(configDir, ARCHIVO), 'utf8'))
    return v && typeof v === 'object' ? (v as Almacen) : {}
  } catch {
    return {}
  }
}

function escribir(configDir: string, almacen: Almacen): void {
  fs.mkdirSync(configDir, { recursive: true })
  const ruta = path.join(configDir, ARCHIVO)
  fs.writeFileSync(ruta + '.tmp', JSON.stringify(almacen, null, 2), 'utf8')
  fs.renameSync(ruta + '.tmp', ruta)
}

export function hasSecret(configDir: string, nombre: string): boolean {
  return typeof leer(configDir)[nombre] === 'string'
}

export function getSecret(configDir: string, nombre: string): string | null {
  const cifrado = leer(configDir)[nombre]
  if (!cifrado) return null
  try {
    return safeStorage.decryptString(Buffer.from(cifrado, 'base64'))
  } catch {
    return null
  }
}

export function setSecret(configDir: string, nombre: string, valor: string): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows no permite cifrar la clave en este equipo; no se guarda sin cifrar.')
  const almacen = leer(configDir)
  almacen[nombre] = safeStorage.encryptString(valor).toString('base64')
  escribir(configDir, almacen)
}

export function deleteSecret(configDir: string, nombre: string): void {
  const almacen = leer(configDir)
  if (!(nombre in almacen)) return
  delete almacen[nombre]
  escribir(configDir, almacen)
}
