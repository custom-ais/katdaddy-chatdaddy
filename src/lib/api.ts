export class ApiError extends Error { constructor(public status:number,message:string){super(message);} }
export async function api<T=any>(path:string,{method='GET',body,token,signal}:{method?:string;body?:unknown;token?:string;signal?:AbortSignal}={}):Promise<T>{
 const response=await fetch(path,{method,headers:{'Content-Type':'application/json','X-BOB-Request':'1',...(token?{'X-BOB-Session':token}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{}),credentials:'same-origin',signal});
 let result:any;try{result=await response.json();}catch{throw new ApiError(response.status,'The server returned an unreadable response. Check the server and try again.');}
 if(!response.ok)throw new ApiError(response.status,result.error||'The request could not be completed.');return result;
}
export function saveText(name:string,text:string,type='text/plain'){
 const a=document.createElement('a'),url=URL.createObjectURL(new Blob([text],{type}));a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
