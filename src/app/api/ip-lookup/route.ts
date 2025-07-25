import { NextResponse } from 'next/server';

// 使用多个备用API，以防某个API失败
const IP_APIS = {
  // 获取IP地址的API
  ipify: 'https://api.ipify.org?format=json',
  ipinfo: 'https://ipinfo.io/json',
  httpbin: 'https://httpbin.org/ip',
  
  // 获取IP详细信息的API
  ipapi: (ip: string) => `https://ipapi.co/${ip}/json/`,
  ipwhois: (ip: string) => `https://ipwho.is/${ip}`
};

// 添加缓存以提高性能
const CACHE_DURATION = 3600; // 1小时，单位：秒
const ipCache = new Map<string, { data: any, timestamp: number }>();

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ip = searchParams.get('ip');
  const noCache = searchParams.get('no_cache') === 'true';
  
  try {
    // 如果没有提供IP，获取访问者的真实IP
    let ipToLookup: string = ip || '';
    
    if (!ipToLookup) {
      // 从请求头中获取访问者的真实IP地址
      const forwarded = request.headers.get('x-forwarded-for');
      const realIp = request.headers.get('x-real-ip');
      const cfConnectingIp = request.headers.get('cf-connecting-ip'); // Cloudflare
      
      if (cfConnectingIp) {
        ipToLookup = cfConnectingIp;
      } else if (forwarded) {
        // x-forwarded-for 可能包含多个IP，取第一个
        ipToLookup = forwarded.split(',')[0].trim();
      } else if (realIp) {
        ipToLookup = realIp;
      }
      
      // 如果还是没有获取到IP，返回错误
      if (!ipToLookup) {
        return NextResponse.json({
          error: '无法获取访问者IP地址',
          tip: '可能是因为您在本地环境或代理后面'
        }, { status: 400 });
      }
      
      // 过滤掉本地IP地址
      if (ipToLookup === '127.0.0.1' || ipToLookup === '::1' || ipToLookup.startsWith('192.168.') || ipToLookup.startsWith('10.') || ipToLookup.startsWith('172.')) {
        return NextResponse.json({
          error: '检测到本地IP地址',
          ip: ipToLookup,
          tip: '您可能在本地环境中，无法获取公网IP信息'
        }, { status: 400 });
      }
    }
    
    // 如果仍然没有IP，返回错误
    if (!ipToLookup) {
      return NextResponse.json(
        { error: '无法获取IP地址' },
        { status: 400 }
      );
    }
    
    // 检查缓存
    if (!noCache && ipCache.has(ipToLookup)) {
      const cachedData = ipCache.get(ipToLookup);
      if (cachedData && (Date.now() - cachedData.timestamp) / 1000 < CACHE_DURATION) {
        return NextResponse.json(cachedData.data);
      }
    }
    
    console.log('查询IP:', ipToLookup); // 调试信息
    
    // 获取IP详细信息
    let ipDetails = null;
    let error = null;
    
    // 尝试第一个API
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      
      const geoResponse = await fetch(IP_APIS.ipapi(ipToLookup), { 
        cache: 'no-store',
        headers: { 'Accept': 'application/json' },
        signal: controller.signal
      }).finally(() => clearTimeout(timeoutId));
      
      if (geoResponse.ok) {
        const data = await geoResponse.json();
        console.log('第一个API响应:', data); // 调试信息
        
        if (!data.error) {
          ipDetails = {
            ip: ipToLookup,
            country: data.country_name || '未知',
            region: data.region || '未知',
            city: data.city || '未知',
            isp: data.org || '未知',
            timezone: data.timezone || '未知',
            lat: data.latitude,
            lon: data.longitude
          };
        } else {
          error = data.reason || '无效的IP地址';
        }
      }
    } catch (err) {
      console.error('第一个API查询失败:', err);
      error = '获取IP地理位置信息失败';
    }
    
    // 如果第一个API失败，尝试第二个API
    if (!ipDetails) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        
        const geoResponse = await fetch(IP_APIS.ipwhois(ipToLookup), { 
          cache: 'no-store',
          headers: { 'Accept': 'application/json' },
          signal: controller.signal
        }).finally(() => clearTimeout(timeoutId));
        
        if (geoResponse.ok) {
          const data = await geoResponse.json();
          console.log('第二个API响应:', data); // 调试信息
          
          if (data.success) {
            ipDetails = {
              ip: ipToLookup,
              country: data.country || '未知',
              region: data.region || '未知',
              city: data.city || '未知',
              isp: data.connection?.isp || '未知',
              timezone: data.timezone?.id || '未知',
              lat: data.latitude,
              lon: data.longitude
            };
          }
        }
      } catch (err) {
        console.error('第二个API查询失败:', err);
        if (!error) {
          error = '获取IP地理位置信息失败';
        }
      }
    }
    
    // 如果所有地理位置API都失败了，至少返回IP地址
    if (!ipDetails) {
      console.log('所有地理位置API都失败，返回基本IP信息');
      const fallbackResponse = {
        ip: ipToLookup,
        country: '未知',
        region: '未知',
        city: '未知',
        isp: '未知',
        timezone: '未知'
      };
      
      return NextResponse.json(fallbackResponse);
    }
    
    // 保存到缓存
    ipCache.set(ipToLookup, {
      data: ipDetails,
      timestamp: Date.now()
    });
    
    // 清理过期缓存
    if (ipCache.size > 100) { // 限制缓存大小
      const now = Date.now();
      for (const [key, value] of ipCache.entries()) {
        if ((now - value.timestamp) / 1000 > CACHE_DURATION) {
          ipCache.delete(key);
        }
      }
    }
    
    return NextResponse.json(ipDetails);
  } catch (error) {
    console.error('IP查询错误:', error);
    return NextResponse.json(
      { 
        error: error instanceof Error ? error.message : '获取IP信息失败',
        ip: ip || '未知'
      },
      { status: 500 }
    );
  }
}